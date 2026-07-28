// Package api exposes Configer's HTTP REST API.
//
// Reads serve the parameter grid straight from the managed Git working tree.
// Writes are git-native: cell edits stage into a draft change request;
// submitting turns the draft into a branch + commit (+ hosted PR when
// configured); merging publishes.
//
// The package is organized by resource: server wiring and routing here,
// read endpoints in reads.go, the validated value write path in values.go,
// parameter and instance mutations in parameters.go / instances.go, the
// change-request lifecycle in changes.go, git liveness in sync.go, drift
// reconciliation in reconcile.go, and shared plumbing in helpers.go.
package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/changeset"
	"github.com/abhijeet-oxide/configer/backend/internal/crstore"
	"github.com/abhijeet-oxide/configer/backend/internal/gitengine"
	"github.com/abhijeet-oxide/configer/backend/internal/grid"
	"github.com/abhijeet-oxide/configer/backend/internal/parsers"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/provider"
	"github.com/abhijeet-oxide/configer/backend/internal/repobackend"
	"github.com/abhijeet-oxide/configer/backend/internal/resolver"
	"github.com/abhijeet-oxide/configer/backend/internal/sources"
)

// Server holds the wired services behind the HTTP surface.
type Server struct {
	// RepoPath is the directory the read engine reads: a git working tree
	// (local backend) or a materialized cache (remote backend).
	RepoPath string
	Registry *plugin.Registry
	Backend  repobackend.Backend
	Store    crstore.Store
	Changes  *changeset.Service
	// Version and Environment identify this deployment in the UI and API
	// (CONFIGER_VERSION / CONFIGER_ENV, e.g. "1.4.0" / "production").
	Version     string
	Environment string
	// treeMu serializes writes to the working tree and the git plumbing over
	// it; drafts serializes read-modify-write sequences on one owner's draft.
	// See locks.go for why they are separate.
	treeMu   treeLock
	drafts   draftLocks
	sync     syncState // git-liveness status (see sync.go)
	syncStop chan struct{}
	// snapshots memoizes the timeline's per-commit configuration states. A
	// commit is immutable, so this needs no invalidation (see snapshotcache.go).
	snapshots *snapshotCache
	// cache memoizes the parsed working tree (project metadata and parsed
	// configuration files) for as long as the files behind it are unchanged
	// (see treecache.go).
	cache *treeCache
}

// branch returns the backend's default working branch (best effort).
func (s *Server) branch() string {
	b, _ := s.Backend.DefaultBranch(context.Background())
	return b
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// envBool reads a boolean environment variable, falling back to def when unset
// or unparseable. Recognizes 1/true/yes/on (case-insensitive) as true.
func envBool(k string, def bool) bool {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return def
	}
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

// changePolicy builds the review gate from the environment. It defaults to the
// permissive single-user tool, and tightens automatically once login is
// configured (GITHUB_OAUTH_CLIENT_ID present): on a shared deployment an author
// cannot self-approve and nothing publishes without a recorded approval. Each
// gate is individually overridable.
func changePolicy() changeset.Policy {
	multiUser := os.Getenv("GITHUB_OAUTH_CLIENT_ID") != ""
	return changeset.Policy{
		RequireApproval:         envBool("CONFIGER_REQUIRE_APPROVAL", multiUser),
		RequireSeparateApprover: envBool("CONFIGER_REQUIRE_SEPARATE_APPROVER", multiUser),
		MinApprovals:            getenvInt("CONFIGER_MIN_APPROVALS", 1),
	}
}

// New builds a Server: plugins registered, repo opened (or bootstrapped into
// git), CR store loaded, PR provider detected from the origin remote.
func New(repoPath string) (*Server, error) { return newServer(repoPath, false, nil) }

// NewExisting opens a tree that MUST already be a git repository - a copy
// Configer made itself.
//
// The difference from New is not pedantry. New will initialize a repository
// where there is none, which is right for a folder someone pointed at and
// wrong for a copy Configer just fetched: if the repository data is missing
// there, the fetch failed, and quietly making a fresh empty repository on top
// of it buries that. It surfaced as "nothing to commit" from a git command the
// user never asked for, about a repository that was not theirs.
func NewExisting(repoPath string) (*Server, error) { return newServer(repoPath, true, nil) }

// NewWithStore opens a repository using a change-request store the caller
// picked (see crStore). A nil store falls back to the JSON file beside the
// repository, which is what single-repo deployments and tests want.
func NewWithStore(repoPath string, mustExist bool, store crstore.Store) (*Server, error) {
	return newServer(repoPath, mustExist, store)
}

func newServer(repoPath string, mustExist bool, crs crstore.Store) (*Server, error) {
	reg := plugin.NewRegistry()
	parsers.Register(reg)
	sources.Register(reg)

	if mustExist && !gitengine.IsRepo(repoPath) {
		slog.Error("a copy Configer made has no repository data in it", slog.String("path", repoPath))
		return nil, errors.New("the copy on this server is missing its repository data, so it cannot be read")
	}
	gitName := getenv("CONFIGER_GIT_NAME", "Configer Bot")
	gitEmail := getenv("CONFIGER_GIT_EMAIL", "configer-bot@localhost")
	repo, err := gitengine.EnsureRepo(repoPath, gitName, gitEmail)
	if err != nil {
		return nil, err
	}

	// Configer is write-back-native: it edits the repository's OWN files and
	// keeps change-request state beside them. A tree it cannot write to cannot
	// be managed, so find out now, in one sentence, instead of at the first edit
	// - where it used to surface as "mkdir /repo/.git/configer: permission
	// denied" from somewhere deep in a save.
	if err := ensureRepoWritable(repoPath); err != nil {
		return nil, err
	}

	if crs == nil {
		fileStore, err := crstore.New(filepath.Join(repoPath, ".git", "configer", "state.json"))
		if err != nil {
			return nil, err
		}
		crs = fileStore
	}

	var prov provider.Provider
	if origin := repo.OriginURL(); origin != "" {
		// A token embedded in the clone's origin URL (private repositories
		// connected with a token) wins over the server-wide env token.
		token := os.Getenv("GITHUB_TOKEN")
		if t := gitengine.TokenFromURL(origin); t != "" {
			token = t
		}
		prov = provider.ForOrigin(origin, token)
		if prov != nil {
			slog.Info("PR provider resolved", slog.String("provider", prov.Name()), slog.String("origin", gitengine.Redact(origin)))
		} else {
			slog.Info("PR provider none (pure-git mode)", slog.String("origin", gitengine.Redact(origin)))
		}
	} else {
		slog.Info("PR provider none (local repository, no remote)")
	}

	backend := repobackend.NewLocal(repo, prov)
	return NewWithBackend(reg, backend, crs), nil
}

// ensureRepoWritable checks that Configer can write to the repository it was
// asked to manage, creating the directory its change-request state lives in.
// The returned message is the one a user sees next to the application, so it
// says what is wrong in plain words; the log line carries the detail an
// operator needs (the path and the account that could not write to it).
func ensureRepoWritable(repoPath string) error {
	stateDir := filepath.Join(repoPath, ".git", "configer")
	err := os.MkdirAll(stateDir, 0o755)
	if err == nil {
		// MkdirAll succeeds on a directory that ALREADY exists, whatever its
		// permissions - so on its own it happily passes a tree left behind by a
		// previous run under a different account, and the repository looks
		// healthy right up until the first edit. Only a real write proves it.
		var probe *os.File
		probe, err = os.CreateTemp(stateDir, ".writable-*")
		if err == nil {
			name := probe.Name()
			_ = probe.Close()
			_ = os.Remove(name)
		}
	}
	if err != nil {
		slog.Error("repository is not writable by the service account",
			slog.String("path", repoPath),
			slog.Int("uid", os.Getuid()),
			slog.Any("error", err))
		return errors.New("this repository's folder is read-only for Configer, " +
			"so changes could not be saved back to it. Give the account Configer " +
			"runs as write access to the folder and reconnect it")
	}
	return nil
}

// NewWithBackend assembles a Server around a prepared backend and store (the
// remote-mode entry point; New is the local convenience wrapper).
func NewWithBackend(reg *plugin.Registry, backend repobackend.Backend, store crstore.Store) *Server {
	return &Server{
		RepoPath:    backend.RootDir(),
		Registry:    reg,
		Backend:     backend,
		Store:       store,
		Changes:     &changeset.Service{Backend: backend, Store: store, Bot: bot(), Policy: changePolicy()},
		Version:     getenv("CONFIGER_VERSION", "dev"),
		Environment: getenv("CONFIGER_ENV", "development"),
		snapshots:   newSnapshotCache(snapshotCacheMax),
		cache:       newTreeCache(backend.RootDir()),
	}
}

// Routes returns the standalone HTTP handler (CORS included) for single-repo
// deployments and tests.
func (s *Server) Routes() http.Handler { return withCORS(s.Handler()) }

// Handler returns the raw per-repo mux; the workspace Hub mounts it under
// /api/repos/{id}/ and applies CORS once at the outer edge.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("GET /api/plugins", s.plugins)
	mux.HandleFunc("GET /api/source-plugins", s.sourcePlugins)
	mux.HandleFunc("GET /api/sources", s.listSources)
	mux.HandleFunc("POST /api/sources", s.addSource)
	mux.HandleFunc("PUT /api/sources/{id}", s.updateSource)
	mux.HandleFunc("DELETE /api/sources/{id}", s.deleteSource)
	mux.HandleFunc("GET /api/sources/{id}/browse", s.browseSource)
	mux.HandleFunc("GET /api/sources/{id}/contents", s.sourceContents)
	mux.HandleFunc("GET /api/sources/incoming", s.incomingChanges)
	mux.HandleFunc("POST /api/sources/incoming/accept", s.acceptIncoming)
	mux.HandleFunc("POST /api/sources/refresh", s.refreshSources)
	mux.HandleFunc("POST /api/parameters/{id}/source", s.mapParameterSource)
	mux.HandleFunc("GET /api/project", s.projectInfo)
	mux.HandleFunc("GET /api/application", s.getApplication)
	mux.HandleFunc("PUT /api/application", s.updateApplication)
	mux.HandleFunc("POST /api/deinit", s.deinit)
	mux.HandleFunc("GET /api/grid", s.grid)
	mux.HandleFunc("GET /api/instances", s.instances)
	mux.HandleFunc("GET /api/parameters/{id}", s.parameter)
	mux.HandleFunc("GET /api/parameters/{id}/history", s.parameterHistory)
	mux.HandleFunc("GET /api/compare", s.compare)
	mux.HandleFunc("GET /api/locate", s.locate)
	mux.HandleFunc("GET /api/render/{instance}", s.render)
	mux.HandleFunc("POST /api/scan", s.scan)
	mux.HandleFunc("GET /api/validation/presets", s.presets)
	mux.HandleFunc("PUT /api/values", s.stageValue)
	mux.HandleFunc("PUT /api/values/bulk", s.bulkStageValue)
	mux.HandleFunc("DELETE /api/values", s.revertValue)
	mux.HandleFunc("PUT /api/parameters/{id}", s.updateParameter)
	mux.HandleFunc("POST /api/parameters", s.addParameter)
	mux.HandleFunc("DELETE /api/parameters/{id}", s.deleteParameter)
	mux.HandleFunc("POST /api/instances", s.addInstance)
	mux.HandleFunc("PUT /api/instances/{name}", s.updateInstance)
	mux.HandleFunc("DELETE /api/instances/{name}", s.deleteInstance)
	mux.HandleFunc("POST /api/instances/{name}/copy-from", s.copyInstanceValues)
	mux.HandleFunc("POST /api/import/analyze", s.analyzeImport)
	mux.HandleFunc("GET /api/changes", s.listChanges)
	mux.HandleFunc("GET /api/changes/draft", s.currentDraft)
	mux.HandleFunc("GET /api/changes/{id}", s.getChange)
	mux.HandleFunc("GET /api/changes/{id}/preview", s.previewChange)
	mux.HandleFunc("GET /api/changes/{id}/pr-status", s.prStatus)
	mux.HandleFunc("POST /api/changes/{id}/submit", s.submitChange)
	mux.HandleFunc("POST /api/changes/{id}/approve", s.approveChange)
	mux.HandleFunc("POST /api/changes/{id}/merge", s.mergeChange)
	mux.HandleFunc("POST /api/changes/{id}/revert", s.revertChange)
	mux.HandleFunc("POST /api/changes/{id}/reject", s.rejectChange)
	mux.HandleFunc("POST /api/changes/{id}/comments", s.addChangeComment)
	mux.HandleFunc("PUT /api/changes/{id}/reviewers", s.setChangeReviewers)
	mux.HandleFunc("GET /api/repo/status", s.repoStatus)
	mux.HandleFunc("GET /api/repo/refs", s.repoRefs)
	mux.HandleFunc("GET /api/history", s.history)
	mux.HandleFunc("GET /api/timeline", s.timeline)
	mux.HandleFunc("GET /api/timeline/snapshot", s.timelineSnapshot)
	mux.HandleFunc("POST /api/restore", s.restore)
	mux.HandleFunc("POST /api/repo/sync", s.repoSync)
	mux.HandleFunc("GET /api/meta", s.meta)
	mux.HandleFunc("GET /api/repo/findings", s.findings)
	mux.HandleFunc("POST /api/repo/findings/ack", s.ackFindings)
	mux.HandleFunc("POST /api/import", s.importParameters)
	mux.HandleFunc("POST /api/parameters/retire-file", s.retireFile)
	mux.HandleFunc("POST /api/discover", s.discover)
	mux.HandleFunc("POST /api/init", s.initApp)
	mux.HandleFunc("PUT /api/files/draft", s.stageFileEdit)
	return mux
}

// lockDraft takes the draft lock for one owner and returns its release, so
// handlers read `defer s.lockDraft(draftOwner(r))()`.
func (s *Server) lockDraft(owner string) func() { return s.drafts.lock(owner) }

// lockDraftOf takes the draft lock for whoever owns change request id. Paths
// that address a change by id (submit, merge, reject) cannot use the caller's
// own owner: an approver acts on somebody else's change, and it is the author's
// draft that must hold still.
func (s *Server) lockDraftOf(id int) func() {
	owner := ""
	if cr, err := s.Store.Get(id); err == nil {
		owner = cr.Author
	}
	return s.drafts.lock(owner)
}

// load returns the project for the working tree, reusing the previous parse
// while the .configer files behind it are unchanged.
//
// The result is SHARED with every other in-flight request and must be treated
// as read-only. Nothing in the read paths writes through it (metadata changes
// go through the writer package, which edits the files, and the next load
// picks them up), so this is a restriction the code already observes.
func (s *Server) load() (*project.Project, error) {
	return s.cache.Project(s.treeMu.Gen())
}

// docs returns the shared parsed-document cache for a project, but only when
// the project is the working tree this server serves. A project materialized
// at some other ref has different bytes under the same relative paths, so it
// parses for itself.
func (s *Server) docs(p *project.Project) resolver.Docs {
	if s.cache == nil || p == nil || p.Root != s.cache.root {
		return nil
	}
	return s.cache.docsAt(s.treeMu.Gen())
}

// resolve builds a resolver for a project, reading through the shared document
// cache when the project is this server's working tree. Every read path in the
// api package should construct resolvers here rather than calling the resolver
// package directly, so none of them silently drops back to re-parsing the whole
// repository on every request.
func (s *Server) resolve(p *project.Project) *resolver.Resolver {
	return resolver.NewWithCatalog(p.Root, p.Catalog.Parameters).WithDocs(s.docs(p))
}

// buildGrid assembles the grid through the shared document cache.
func (s *Server) buildGrid(p *project.Project) grid.Grid {
	return grid.BuildWith(p, s.docs(p))
}

// loadWithDraft loads the project alongside the caller's draft; grid builders
// preview the draft's pending items on top via grid.ApplyDraft, so the UI
// shows exactly what submitting would write. The draft is author-scoped, so
// each editor previews their own pending changes, never a colleague's.
func (s *Server) loadWithDraft(author string) (*project.Project, *change.ChangeRequest, error) {
	p, err := s.load()
	if err != nil {
		return nil, nil, err
	}
	return p, s.Store.CurrentDraft(author), nil
}

// projectAtRef loads the project at a git ref for read-only compare/render.
// An empty ref is the current working tree; a named ref is materialized
// read-only into a temp dir via the backend and torn down by the returned func.
func (s *Server) projectAtRef(ref string) (*project.Project, func(), error) {
	noop := func() {}
	if ref == "" {
		p, err := s.load()
		return p, noop, err
	}
	base, err := os.MkdirTemp("", "configer-ref-")
	if err != nil {
		return nil, noop, err
	}
	dir := filepath.Join(base, "tree") // must not pre-exist for a detached worktree
	cleanup, err := s.Backend.MaterializeRef(context.Background(), ref, dir)
	if err != nil {
		_ = os.RemoveAll(base)
		return nil, noop, err
	}
	p, err := project.Load(dir)
	if err != nil {
		cleanup()
		_ = os.RemoveAll(base)
		return nil, noop, err
	}
	return p, func() { cleanup(); _ = os.RemoveAll(base) }, nil
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// meta identifies this deployment: shown in the UI footer and used for
// professional, environment-aware messaging (never "localhost" jargon).
//
// @Summary     Deployment identity
// @Description Name, version, environment, current project and branch. Backs the UI footer and environment-aware messaging.
// @Tags        Health
// @Produce     json
// @Success     200 {object} MetaResponse
// @Router      /api/meta [get]
func (s *Server) meta(w http.ResponseWriter, _ *http.Request) {
	branch := s.branch()
	project := ""
	if p, err := s.load(); err == nil {
		project = p.Name()
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"name":        "Configer",
		"version":     s.Version,
		"environment": s.Environment,
		"project":     project,
		"branch":      branch,
	})
}

// plugins lists the registered format plugins (yaml/json/xml parsers).
//
// @Summary     List format plugins
// @Description The registered parser/format plugin manifests (yaml, json, xml).
// @Tags        Plugins & validation
// @Produce     json
// @Success     200 {array} object
// @Router      /api/plugins [get]
func (s *Server) plugins(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Registry.Manifests())
}
