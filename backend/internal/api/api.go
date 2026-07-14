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
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/changeset"
	"github.com/abhijeet-oxide/configer/backend/internal/crstore"
	"github.com/abhijeet-oxide/configer/backend/internal/gitengine"
	"github.com/abhijeet-oxide/configer/backend/internal/parsers"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/provider"
	"github.com/abhijeet-oxide/configer/backend/internal/repobackend"
)

// Server holds the wired services behind the HTTP surface.
type Server struct {
	// RepoPath is the directory the read engine reads: a git working tree
	// (local backend) or a materialized cache (remote backend).
	RepoPath string
	Registry *plugin.Registry
	Backend  repobackend.Backend
	Store    *crstore.Store
	Changes  *changeset.Service
	// Version and Environment identify this deployment in the UI and API
	// (CONFIGER_VERSION / CONFIGER_ENV, e.g. "1.4.0" / "production").
	Version     string
	Environment string
	writeMu     sync.Mutex // serializes writes to the working tree + store
	sync        syncState  // git-liveness status (see sync.go)
	syncStop    chan struct{}
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

// New builds a Server: plugins registered, repo opened (or bootstrapped into
// git), CR store loaded, PR provider detected from the origin remote.
func New(repoPath string) (*Server, error) {
	reg := plugin.NewRegistry()
	parsers.Register(reg)

	gitName := getenv("CONFIGER_GIT_NAME", "Configer Bot")
	gitEmail := getenv("CONFIGER_GIT_EMAIL", "configer-bot@localhost")
	repo, err := gitengine.EnsureRepo(repoPath, gitName, gitEmail)
	if err != nil {
		return nil, err
	}

	store, err := crstore.New(filepath.Join(repoPath, ".git", "configer", "state.json"))
	if err != nil {
		return nil, err
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
			log.Printf("PR provider: %s (origin %s)", prov.Name(), gitengine.Redact(origin))
		} else {
			log.Printf("PR provider: none (pure-git mode, origin %s)", gitengine.Redact(origin))
		}
	} else {
		log.Printf("PR provider: none (local repository, no remote)")
	}

	backend := repobackend.NewLocal(repo, prov)
	return NewWithBackend(reg, backend, store), nil
}

// NewWithBackend assembles a Server around a prepared backend and store (the
// remote-mode entry point; New is the local convenience wrapper).
func NewWithBackend(reg *plugin.Registry, backend repobackend.Backend, store *crstore.Store) *Server {
	return &Server{
		RepoPath:    backend.RootDir(),
		Registry:    reg,
		Backend:     backend,
		Store:       store,
		Changes:     &changeset.Service{Backend: backend, Store: store},
		Version:     getenv("CONFIGER_VERSION", "dev"),
		Environment: getenv("CONFIGER_ENV", "development"),
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
	mux.HandleFunc("GET /api/project", s.projectInfo)
	mux.HandleFunc("GET /api/grid", s.grid)
	mux.HandleFunc("GET /api/instances", s.instances)
	mux.HandleFunc("GET /api/parameters/{id}", s.parameter)
	mux.HandleFunc("GET /api/parameters/{id}/history", s.parameterHistory)
	mux.HandleFunc("GET /api/compare", s.compare)
	mux.HandleFunc("GET /api/render/{instance}", s.render)
	mux.HandleFunc("POST /api/scan", s.scan)
	mux.HandleFunc("GET /api/validation/presets", s.presets)
	mux.HandleFunc("PUT /api/values", s.stageValue)
	mux.HandleFunc("DELETE /api/values", s.revertValue)
	mux.HandleFunc("PUT /api/parameters/{id}", s.updateParameter)
	mux.HandleFunc("POST /api/parameters", s.addParameter)
	mux.HandleFunc("DELETE /api/parameters/{id}", s.deleteParameter)
	mux.HandleFunc("POST /api/instances", s.addInstance)
	mux.HandleFunc("PUT /api/instances/{name}", s.updateInstance)
	mux.HandleFunc("DELETE /api/instances/{name}", s.deleteInstance)
	mux.HandleFunc("GET /api/changes", s.listChanges)
	mux.HandleFunc("GET /api/changes/draft", s.currentDraft)
	mux.HandleFunc("GET /api/changes/{id}", s.getChange)
	mux.HandleFunc("POST /api/changes/{id}/submit", s.submitChange)
	mux.HandleFunc("POST /api/changes/{id}/merge", s.mergeChange)
	mux.HandleFunc("POST /api/changes/{id}/reject", s.rejectChange)
	mux.HandleFunc("GET /api/repo/status", s.repoStatus)
	mux.HandleFunc("GET /api/repo/refs", s.repoRefs)
	mux.HandleFunc("GET /api/history", s.history)
	mux.HandleFunc("POST /api/repo/sync", s.repoSync)
	mux.HandleFunc("GET /api/meta", s.meta)
	mux.HandleFunc("GET /api/repo/findings", s.findings)
	mux.HandleFunc("POST /api/repo/findings/ack", s.ackFindings)
	mux.HandleFunc("POST /api/import", s.importParameters)
	mux.HandleFunc("POST /api/parameters/retire-file", s.retireFile)
	mux.HandleFunc("POST /api/discover", s.discover)
	mux.HandleFunc("POST /api/init", s.initApp)
	return mux
}

func (s *Server) load() (*project.Project, error) { return project.Load(s.RepoPath) }

// loadWithDraft loads the project alongside the current draft; grid builders
// preview the draft's pending items on top via grid.ApplyDraft, so the UI
// shows exactly what submitting would write.
func (s *Server) loadWithDraft() (*project.Project, *change.ChangeRequest, error) {
	p, err := s.load()
	if err != nil {
		return nil, nil, err
	}
	return p, s.Store.CurrentDraft(), nil
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

func (s *Server) plugins(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Registry.Manifests())
}
