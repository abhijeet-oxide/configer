package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/auth"
	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/gitengine"
	"github.com/abhijeet-oxide/configer/backend/internal/parsers"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/provider"
	"github.com/abhijeet-oxide/configer/backend/internal/remoterepo"
	"github.com/abhijeet-oxide/configer/backend/internal/repobackend"
	"github.com/abhijeet-oxide/configer/backend/internal/search"
	"github.com/abhijeet-oxide/configer/backend/internal/sources"
	"github.com/abhijeet-oxide/configer/backend/internal/store"
	"github.com/abhijeet-oxide/configer/backend/internal/workspace"
)

// Hub serves a workspace of repositories. Every repo-scoped endpoint is
// mounted under /api/repos/{id}/..., the workspace endpoints manage the
// registry (connect, list, disconnect), and the unscoped /api/... routes keep
// working against the default repository so single-repo deployments and older
// clients see no change. Each repository is served by a repobackend.Backend:
// LocalBackend (a git working tree) or, when connected in remote mode,
// RemoteBackend (the GitHub Git data API with no clone, phase R2).
type Hub struct {
	Version     string
	Environment string
	Logger      *slog.Logger

	dataDir  string
	interval time.Duration
	registry workspace.Registry
	platform *store.Store
	auth     *auth.Service

	mu       sync.Mutex
	servers  map[string]*Server
	handlers map[string]http.Handler
	errs     map[string]string // repos that failed to open, id -> reason
	// connecting holds repositories whose clone/open is still running in the
	// background (POST /repos returns 202 immediately). Entries appear in the
	// portfolio with status "connecting" and, on failure, "error", so the UI
	// can show progress and outcome by polling instead of blocking the request.
	connecting map[string]*connecting

	// index is the cross-application metadata search index (nil is tolerated:
	// every use is guarded). reindexCh feeds a single worker that rebuilds one
	// app's docs; reindexPending coalesces bursts so a flurry of writes to the
	// same app collapses to one rebuild.
	index          *search.Index
	reindexCh      chan string
	reindexPending map[string]bool

	// gitRoles memoizes each user's permission on each application's repository
	// (see access.go): authorization runs on every repo-scoped request, so the
	// mirrored role cannot be a GitHub call each time.
	gitRoles *gitRoleCache

	// cloning holds the ids whose connect worker is still running. An id names a
	// FOLDER on the server, so it must not be handed out again while the first
	// attempt is still writing there - two clones in one directory delete each
	// other's files and fail with something about Configer's own storage that
	// the user can neither see nor fix. An entry outlives its `connecting` row:
	// dismissing a slow connection stops the waiting, not the git process.
	cloning map[string]bool

	// opens serializes on-demand opens per application, and openErrs remembers
	// a failed one for a while so a broken origin is not re-cloned on every
	// request (see lazyopen.go).
	opens    keyedLocks
	openErrs map[string]openFailure
}

// NewHub loads the workspace registry (from the platform database, importing an
// existing workspace.json once) and returns immediately. Applications open on
// first use, so starting the service never waits on a repository. When the
// registry is empty and seed points at an existing directory, that directory is
// registered in place (CONFIGER_REPO keeps its meaning as the bootstrap
// repository).
func NewHub(dataDir, seed string, interval time.Duration) (*Hub, error) {
	// Everything derived from here ends up in a registry entry, a git argument
	// or a log line, and a relative path is wrong in all three: it depends on
	// where the service happened to be started, and git resolves it a second
	// time against its own working directory. Settle it once, at the door.
	if a, aerr := filepath.Abs(dataDir); aerr == nil {
		dataDir = a
	}
	// A stopped server can leave a half-copied repository behind. Clearing it
	// here means nobody ever meets it.
	sweepIncoming(dataDir)
	platform, authSvc, err := newPlatform(dataDir)
	if err != nil {
		return nil, err
	}
	reg, err := openRegistry(dataDir, platform)
	if err != nil {
		return nil, err
	}
	h := &Hub{
		Version:     getenv("CONFIGER_VERSION", "dev"),
		Environment: getenv("CONFIGER_ENV", "development"),
		dataDir:     dataDir,
		interval:    interval,
		registry:    reg,
		platform:    platform,
		auth:        authSvc,
		servers:     map[string]*Server{},
		handlers:    map[string]http.Handler{},
		errs:        map[string]string{},
		connecting:  map[string]*connecting{},
		cloning:     map[string]bool{},
		gitRoles:    newGitRoleCache(),
		openErrs:    map[string]openFailure{},
	}
	// The search index lives in the platform database (SQLite FTS5) with a
	// bounded in-memory tier; on Postgres it runs memory-only. A single worker
	// drains reindex requests off a buffered channel.
	idx, ierr := search.New(platform.DB(), platform.Dialect(), getenvInt("CONFIGER_SEARCH_MEM_MAX", 50000))
	if ierr != nil {
		return nil, ierr
	}
	h.index = idx
	h.reindexCh = make(chan string, 256)
	h.reindexPending = map[string]bool{}
	go h.reindexWorker()
	if authSvc.Enabled() {
		slog.Info("auth enabled: GitHub OAuth", slog.String("store", platform.Dialect()))
	} else {
		// Say WHY, at startup, in the log: "sign-in is not configured" is the
		// one message an operator needs to act on, and hunting for it in the UI
		// (where end users must never see it) is the wrong place to look.
		slog.Info("auth disabled: single-user mode",
			slog.String("store", platform.Dialect()),
			slog.String("reason", authSvc.ConfigProblem()))
	}
	if len(reg.List()) == 0 && seed != "" {
		if st, serr := os.Stat(seed); serr == nil && st.IsDir() {
			abs, _ := filepath.Abs(seed)
			name := workspace.NameFromURL(abs)
			e := workspace.Entry{
				ID: reg.UniqueID(workspace.Slug(name), nil), Name: name,
				Origin: abs, Path: abs, Local: true, AddedAt: time.Now().UTC(),
			}
			if aerr := reg.Add(e); aerr != nil {
				return nil, aerr
			}
			slog.Info("workspace seeded with local repository", slog.String("id", e.ID), slog.String("path", abs))
		}
	}
	// Applications are NOT opened here. Opening one means fetching a repository,
	// and doing that for every application before the process finishes starting
	// is what made a restart take minutes and made the working copies something
	// the deployment had to keep on a surviving disk. They open on first use
	// (see lazyopen.go); this warms them in the background so the portfolio
	// fills in shortly after start without anything waiting on it.
	go h.warmAll()
	return h, nil
}

// Count reports how many repositories are connected.
func (h *Hub) Count() int { return len(h.registry.List()) }

// pathFor is where THIS process keeps an application's working copy.
//
// The registry is shared between replicas now, so a path recorded by one of
// them is not a fact about another. It is only meaningful for a repository
// opened in place (a folder an operator pointed at, on that machine); for a
// copy Configer fetched, the location is derived from this process's own data
// directory, which is what makes a row written by one pod usable by the next.
func (h *Hub) pathFor(e workspace.Entry) string {
	if e.Local {
		return e.Path
	}
	return filepath.Join(h.dataDir, "repos", e.ID)
}

// open builds (or rebuilds) the per-repo server and starts its sync loop.
// Remote repositories are materialized through the API (no clone); cloned
// repositories whose working tree vanished (ephemeral disk) are re-cloned.
func (h *Hub) open(e workspace.Entry) error {
	e.Path = h.pathFor(e)
	var s *Server
	if e.Remote {
		var err error
		if s, err = h.openRemote(e); err != nil {
			return err
		}
	} else {
		if _, err := os.Stat(e.Path); os.IsNotExist(err) && !e.Local {
			gitName := getenv("CONFIGER_GIT_NAME", "Configer Bot")
			gitEmail := getenv("CONFIGER_GIT_EMAIL", "configer-bot@localhost")
			if _, cerr := gitengine.Clone(e.Origin, e.Path, e.Branch, "", gitName, gitEmail); cerr != nil {
				return cerr
			}
		}
		crs, err := h.crStore(e.ID, filepath.Join(e.Path, ".git", "configer", "state.json"))
		if err != nil {
			return err
		}
		// A folder opened in place may legitimately not be a repository yet
		// (Configer initializes one); a copy Configer fetched must already be.
		if s, err = NewWithStore(e.Path, !e.Local, crs); err != nil {
			return err
		}
	}
	s.StartSyncLoop(h.interval)
	h.mu.Lock()
	h.servers[e.ID] = s
	h.handlers[e.ID] = s.Handler()
	delete(h.errs, e.ID)
	h.mu.Unlock()
	return nil
}

// openRemote wires a no-clone server: a RemoteBackend materializes the branch
// into a cache directory the read engine reads, and the CR store lives beside
// it (there is no .git to hold state).
func (h *Hub) openRemote(e workspace.Entry) (*Server, error) {
	reg := plugin.NewRegistry()
	parsers.Register(reg)
	sources.Register(reg)

	gitName := getenv("CONFIGER_GIT_NAME", "Configer Bot")
	gitEmail := getenv("CONFIGER_GIT_EMAIL", "configer-bot@localhost")
	client, err := remoterepo.New(e.Origin, e.Token, gitName, gitEmail)
	if err != nil {
		return nil, err
	}
	prov := provider.ForOrigin(e.Origin, e.Token)
	backend, err := repobackend.NewRemote(context.Background(), client, e.Branch, e.Path, prov)
	if err != nil {
		return nil, err
	}
	// State lives OUTSIDE the materialized cache so it is never swept into a
	// commit by the tree diff (the cache is the repo tree, byte for byte).
	store, err := h.crStore(e.ID, filepath.Join(h.dataDir, "state", e.ID, "state.json"))
	if err != nil {
		return nil, err
	}
	return NewWithBackend(reg, backend, store), nil
}

func (h *Hub) server(id string) (*Server, http.Handler) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.servers[id], h.handlers[id]
}

// enqueueReindex schedules a rebuild of one application's search docs. It
// coalesces: while a rebuild for the same id is already pending, extra requests
// are no-ops, so a burst of writes to one app collapses to a single rebuild. A
// full channel is tolerated (the pending flag is cleared so a later write
// re-enqueues) - the index is best-effort and always reconstructible.
func (h *Hub) enqueueReindex(id string) {
	if id == "" || h.index == nil {
		return
	}
	h.mu.Lock()
	if h.reindexPending[id] {
		h.mu.Unlock()
		return
	}
	h.reindexPending[id] = true
	h.mu.Unlock()

	select {
	case h.reindexCh <- id:
	default:
		h.mu.Lock()
		delete(h.reindexPending, id)
		h.mu.Unlock()
	}
}

func (h *Hub) reindexWorker() {
	for id := range h.reindexCh {
		h.mu.Lock()
		delete(h.reindexPending, id)
		h.mu.Unlock()
		h.reindexApp(id)
	}
}

// reindexApp rebuilds one application's docs from its committed metadata and the
// current change requests. An app that no longer loads (disconnected, or not yet
// initialized) is simply dropped from the index.
func (h *Hub) reindexApp(id string) {
	if h.index == nil {
		return
	}
	s, _ := h.server(id)
	if s == nil {
		_ = h.index.RemoveApp(id)
		return
	}
	p, err := s.load()
	if err != nil {
		_ = h.index.RemoveApp(id)
		return
	}
	docs := search.DocsFor(id, p.Name(), p, s.Store.List())
	if rerr := h.index.ReplaceApp(id, docs); rerr != nil {
		h.log().Warn("search reindex failed", slog.String("id", id), slog.Any("error", rerr))
	}
}

// isMutating reports whether a method changes state, so the dispatch seam knows
// when a successful request warrants a reindex.
func isMutating(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

func getenvInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// defaultHandler serves the unscoped legacy routes: the first healthy
// repository in connection order, opened on demand if it is not serving yet.
func (h *Hub) defaultHandler() http.Handler {
	for _, e := range h.registry.List() {
		if h.ensureOpen(e.ID) {
			_, hd := h.server(e.ID)
			if hd != nil {
				return hd
			}
		}
	}
	return nil
}

// Routes mounts the workspace surface plus per-repo dispatch. The handler chain
// is: observability (request-id, access log, recovery) -> CORS -> mux.
func (h *Hub) Routes() http.Handler {
	mux := http.NewServeMux()
	// Liveness: the process is up. Readiness: at least one repository is
	// serving, so a load balancer only routes traffic once we can answer.
	mux.HandleFunc("GET /api/health", h.health)
	mux.HandleFunc("GET /api/healthz", h.health)
	mux.HandleFunc("GET /api/readyz", h.ready)
	// API documentation: generated spec (JSON + YAML) + interactive (embedded,
	// offline) Swagger UI. The spec is generated from handler annotations.
	mux.HandleFunc("GET /api/openapi.json", serveOpenAPISpecJSON)
	mux.HandleFunc("GET /api/openapi.yaml", serveOpenAPISpecYAML)
	mux.Handle("/api/docs", swaggerHandler)
	mux.Handle("/api/docs/", swaggerHandler)
	h.auth.Routes(mux)
	mux.HandleFunc("GET /api/audit", h.auditLog)
	mux.HandleFunc("GET /api/audit/verify", h.auditVerify)
	// GitHub browsing for the New Application flow (credentials stay server-side).
	mux.HandleFunc("GET /api/github/status", h.githubStatus)
	mux.HandleFunc("GET /api/github/repos", h.githubRepos)
	mux.HandleFunc("GET /api/github/repos/search", h.githubSearchRepos)
	mux.HandleFunc("GET /api/github/orgs", h.githubOrgs)
	mux.HandleFunc("GET /api/github/branches", h.githubBranches)
	// Local-folder picker for the New Application flow (localhost mode).
	mux.HandleFunc("GET /api/fs/browse", h.browseFolders)
	// What this deployment supports, so the UI never offers a workflow that
	// cannot succeed here (see capabilities.go).
	mux.HandleFunc("GET /api/capabilities", h.capabilities)
	mux.HandleFunc("GET /api/workspace", h.list)
	mux.HandleFunc("GET /api/search", h.search)
	mux.HandleFunc("GET /api/repos", h.list)
	mux.HandleFunc("POST /api/repos", h.connect)
	mux.HandleFunc("PATCH /api/repos/{id}", h.rename)
	mux.HandleFunc("DELETE /api/repos/{id}", h.disconnect)
	mux.HandleFunc("GET /api/repos/{id}/role", h.myRole)
	mux.HandleFunc("GET /api/repos/{id}/members", h.members)
	mux.HandleFunc("PUT /api/repos/{id}/members", h.setMember)
	mux.HandleFunc("DELETE /api/repos/{id}/members/{login}", h.removeMember)
	mux.HandleFunc("/api/repos/{id}/", h.dispatch)
	mux.HandleFunc("/api/", h.legacy)
	// Everything that is not the API is the app itself: served from the bundled
	// UI when this deployment has one, so a deep link (or the redirect that ends
	// a login) opens the page it names instead of a "not found".
	if dir := webDir(); dir != "" {
		slog.Info("serving the user interface", slog.String("dir", dir))
		mux.Handle("/", webHandler(dir))
	} else {
		mux.Handle("/", noWebHandler(os.Getenv("CONFIGER_APP_URL")))
	}
	return withObservability(withCompression(withCORS(withBodyLimit(h.auth.Middleware(mux)))), h.log())
}

// Close releases the platform database.
func (h *Hub) Close() error {
	if h.platform != nil {
		return h.platform.Close()
	}
	return nil
}

func (h *Hub) log() *slog.Logger {
	if h.Logger != nil {
		return h.Logger
	}
	return slog.Default()
}

// health is the liveness probe. It also identifies the deployment (name,
// version, environment) so a client can name what it is talking to before -
// and without - any application being connected; /api/meta carries the same
// identity but is repo-scoped.
//
// @Summary     Liveness probe
// @Description Returns 200 while the process is up, with the deployment identity (name, version, environment). `/api/healthz` is an alias. Used as a liveness check by load balancers and orchestrators; it does not check dependencies (see readiness).
// @Tags        Health
// @Produce     json
// @Success     200 {object} StatusResponse
// @Router      /api/health [get]
// @Router      /api/healthz [get]
func (h *Hub) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":      "ok",
		"name":        "Configer",
		"version":     h.Version,
		"environment": h.Environment,
	})
}

// ready reports 200 only when a repository is available to serve, otherwise 503.
//
// @Summary     Readiness probe
// @Description Returns 200 once at least one repository is serving, 503 otherwise, so a load balancer only routes traffic when the service can actually answer.
// @Tags        Health
// @Produce     json
// @Success     200 {object} StatusResponse
// @Failure     503 {object} StatusResponse
// @Router      /api/readyz [get]
func (h *Hub) ready(w http.ResponseWriter, _ *http.Request) {
	// Readiness means this process can answer requests, and it can: applications
	// open on first use, so none of them has to be fetched before traffic is
	// routed here.
	//
	// It used to mean "at least one repository is serving", which was wrong in
	// both directions. It made a restart un-ready for as long as the clones took,
	// and a brand new deployment - which has no repositories precisely because
	// nobody can reach it to add one - could never become ready at all.
	writeJSON(w, http.StatusOK, map[string]string{
		"status": "ready", "applications": strconv.Itoa(h.Count()),
	})
}

// dispatch rewrites /api/repos/{id}/<rest> to /api/<rest> and serves it with
// that repository's own handler, so every existing endpoint works per repo.
// Requests pass role enforcement first and land in the audit trail after.
func (h *Hub) dispatch(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	// Open on first use. This is the request that pays for the working copy,
	// and only for the application it actually asked for.
	h.ensureOpen(id)
	_, hd := h.server(id)
	if hd == nil {
		h.mu.Lock()
		reason := h.errs[id]
		_, pending := h.connecting[id]
		h.mu.Unlock()
		// Plain words, and a stable code the UI renders as a state (an empty
		// page that offers a way out) rather than a failure toast per request.
		msg := "this application is not connected to this deployment"
		switch {
		case pending:
			msg = "this application is still being connected"
		case reason != "":
			msg = "this application is unavailable: " + reason
		}
		writeError(w, r, http.StatusNotFound, CodeUnknownRepository, msg)
		return
	}
	if !h.authorize(w, r, id) {
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/repos/"+id)
	// Share an actor holder between the handler (which resolves the author)
	// and the post-dispatch audit, so the trail records who acted.
	ctx, _ := withActorHolder(r.Context())
	r = r.WithContext(ctx)
	r2 := r.Clone(ctx)
	r2.URL.Path = "/api" + rest
	rec := &statusRecorder{ResponseWriter: w}
	hd.ServeHTTP(rec, r2)
	h.audit(r, id, rec.status)
	// One reindex seam for every write route: a successful mutating request to
	// this app rebuilds its search docs. Cheap (one project load) and coalesced,
	// so it also auto-covers any endpoint added later.
	if isMutating(r.Method) && rec.status < 400 {
		h.enqueueReindex(id)
	}
}

func (h *Hub) legacy(w http.ResponseWriter, r *http.Request) {
	hd := h.defaultHandler()
	if hd == nil {
		// Not a fault: a fresh (or emptied) deployment simply has no application
		// to answer for. The stable code lets a client render an empty state
		// instead of an error.
		writeError(w, r, http.StatusServiceUnavailable, CodeNoRepository,
			"no application is connected yet")
		return
	}
	// The unscoped routes serve the default repository: same enforcement.
	defaultID := ""
	if list := h.registry.List(); len(list) > 0 {
		defaultID = list[0].ID
	}
	if !h.authorize(w, r, defaultID) {
		return
	}
	ctx, _ := withActorHolder(r.Context())
	r = r.WithContext(ctx)
	rec := &statusRecorder{ResponseWriter: w}
	hd.ServeHTTP(rec, r)
	h.audit(r, defaultID, rec.status)
	if isMutating(r.Method) && rec.status < 400 {
		h.enqueueReindex(defaultID)
	}
}

// RepoSummary is the portfolio card for one repository: identity plus enough
// health/shape information for the workspace dashboard drill-down.
type RepoSummary struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Origin  string `json:"origin,omitempty"`
	Local   bool   `json:"local,omitempty"`
	NoClone bool   `json:"noClone,omitempty"`
	Branch  string `json:"branch,omitempty"`
	Project string `json:"project,omitempty"`
	// NeedsSetup is a connected repository that has no Configer application
	// yet (.configer/ absent). It is not an error - the UI routes it into
	// onboarding - so it must never surface as "unavailable".
	NeedsSetup bool `json:"needsSetup,omitempty"`
	Params     int  `json:"params"`
	// Instances counts configuration instances; Environments breaks them
	// down by environment for the hierarchical dashboard.
	Instances    int            `json:"instances"`
	Environments map[string]int `json:"environments,omitempty"`
	OpenChanges  int            `json:"openChanges"`
	Drafts       int            `json:"drafts"`
	Behind       int            `json:"behind,omitempty"`
	SyncError    string         `json:"syncError,omitempty"`
	Provider     string         `json:"provider,omitempty"`
	Remote       string         `json:"remote,omitempty"`
	AddedAt      time.Time      `json:"addedAt"`
	Error        string         `json:"error,omitempty"`
	// Status is "connecting" while a repository is first being added,
	// "opening" while an already-connected one is being made ready on this
	// process (applications open on first use, so a restart shows this until
	// the warmer or a request reaches them), "error" when either failed, and
	// empty ("" = ready) for an application that is serving. The client polls
	// the portfolio until it leaves "connecting" or "opening".
	Status string `json:"status,omitempty"`
	// Role is the CALLER's capability on this application, and RoleSource says
	// where it came from (see access.go). A role belongs to a (person,
	// application) pair - the same person is an approver on one and a viewer on
	// the next - so the portfolio carries it per card rather than the product
	// stamping one label on the person.
	Role       string `json:"role,omitempty"`
	RoleSource string `json:"roleSource,omitempty"`
}

func (h *Hub) summarize(e workspace.Entry) RepoSummary {
	sum := RepoSummary{
		ID: e.ID, Name: e.Name, Origin: gitengine.Redact(e.Origin),
		Local: e.Local, NoClone: e.Remote, AddedAt: e.AddedAt,
	}
	// Deliberately a lookup, never an open: listing the portfolio must not be
	// the thing that fetches every repository in the workspace. An application
	// nobody has opened yet is a STATE ("opening", the warmer is on its way to
	// it), not a failure - only a recorded reason makes it an error.
	s, _ := h.server(e.ID)
	if s == nil {
		if reason := h.openState(e.ID); reason != "" {
			sum.Status, sum.Error = "error", reason
		} else {
			sum.Status = "opening"
		}
		return sum
	}
	sum.Branch = s.branch()
	// A connected repository without a .configer application is a first-class
	// "needs setup" state (routes to onboarding), NOT an error/unavailable.
	if !s.initialized() {
		sum.NeedsSetup = true
	} else if p, err := s.load(); err == nil {
		sum.Project = p.Name()
		sum.Params = len(p.Catalog.Parameters)
		sum.Instances = len(p.Registry.Instances)
		envs := map[string]int{}
		for _, in := range p.Registry.Instances {
			env := in.Environment
			if env == "" {
				env = "unspecified"
			}
			envs[env]++
		}
		if len(envs) > 0 {
			sum.Environments = envs
		}
	} else {
		sum.Error = err.Error()
	}
	for _, cr := range s.Store.List() {
		switch cr.State {
		case change.StateUnderReview, change.StateApproved:
			sum.OpenChanges++
		case change.StateDraft:
			if len(cr.Items) > 0 {
				sum.Drafts++
			}
		}
	}
	// Use the cached liveness snapshot; the sync loop keeps it fresh, and
	// the portfolio view must never block on N remote fetches.
	s.sync.mu.Lock()
	st := s.sync.status
	s.sync.mu.Unlock()
	sum.Behind = st.Behind
	sum.SyncError = st.SyncError
	sum.Provider = st.Provider
	sum.Remote = st.Remote
	return sum
}

// list returns the repository portfolio.
//
// @Summary     List repositories
// @Description The workspace portfolio: every connected repository with health/shape summary (params, instances, environments, open changes, drafts, sync state). `/api/workspace` is an alias.
// @Tags        Workspace
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Router      /api/repos [get]
// @Router      /api/workspace [get]
func (h *Hub) list(w http.ResponseWriter, r *http.Request) {
	entries := h.registry.List()
	out := make([]RepoSummary, 0, len(entries))
	// Each card carries the CALLER's own access to that application, resolved
	// for all of them together (see grantsFor).
	u, signedIn := auth.UserFrom(r.Context())
	var grants map[string]Grant
	if h.auth.Enabled() && signedIn {
		ids := make([]string, 0, len(entries))
		for _, e := range entries {
			ids = append(ids, e.ID)
		}
		grants = h.grantsFor(r, ids, u)
	}
	for _, e := range entries {
		sum := h.summarize(e)
		if !h.auth.Enabled() {
			sum.Role, sum.RoleSource = string(store.RoleApprover), "single-user"
		} else if g, ok := grants[e.ID]; ok {
			sum.Role, sum.RoleSource = string(g.Role), g.Source
		}
		out = append(out, sum)
	}
	// Include repositories still connecting (or that failed to) in the
	// background, so the portfolio reflects in-flight work the client polls.
	h.mu.Lock()
	for _, c := range h.connecting {
		out = append(out, connectingSummary(c))
	}
	h.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"name":        "Configer",
		"version":     h.Version,
		"environment": h.Environment,
		"repos":       out,
	})
}

// search answers the global metadata query across every application. It exposes
// the same class of information the portfolio listing already does (names and
// shapes, never values or file contents), so it needs no extra gating beyond the
// shared middleware. Results carry a structured target the client navigates to.
//
// @Summary     Global search
// @Description Search application metadata (parameters, instances, change requests) across every connected application. Returns lightweight hits with a navigation target; never values or file contents.
// @Tags        Workspace
// @Produce     json
// @Param       q     query string true  "Query text"
// @Param       scope query string false "global (default) or app"
// @Param       repo  query string false "Restrict to one application id"
// @Param       limit query int    false "Max results (default 20, cap 50)"
// @Success     200 {object} map[string]any
// @Router      /api/search [get]
func (h *Hub) search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 0
	if v := q.Get("limit"); v != "" {
		limit, _ = strconv.Atoi(v)
	}
	hits := []search.Hit{}
	if h.index != nil {
		found, err := h.index.Search(q.Get("q"), q.Get("scope"), q.Get("repo"), limit)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, CodeInternalError, "search failed")
			return
		}
		if found != nil {
			hits = found
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"hits": hits})
}

// rename changes an application's display name. Only the human label changes;
// the registry id (and therefore every per-repo route and shared deep link)
// stays stable, and the Git repository is untouched.
// rename changes an application's display name.
//
// @Summary     Rename an application
// @Description Change an application's display name. Only the human label changes; the registry id (and every per-repo route and deep link) stays stable, and the Git repository is untouched.
// @Tags        Workspace
// @Accept      json
// @Produce     json
// @Param       id   path string        true "Repository id"
// @Param       body body RenameRequest true "New name"
// @Success     200 {object} RepoSummary
// @Failure     400 {object} APIError "Malformed body or empty name"
// @Failure     404 {object} APIError "Unknown repository"
// @Security    CookieSession
// @Router      /api/repos/{id} [patch]
func (h *Hub) rename(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !h.requireAppLifecycle(w, r, id, "rename this application") {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "name cannot be empty")
		return
	}
	if len(name) > 80 {
		name = name[:80]
	}
	e, ok := h.registry.Rename(id, name)
	if !ok {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "unknown repository: "+id)
		return
	}
	slog.Info("workspace renamed repository", slog.String("id", id), slog.String("name", name))
	h.auditHub(r, id, "Renamed repository to "+name, "PATCH /repos/"+id)
	writeJSON(w, http.StatusOK, h.summarize(e))
}

// disconnect removes a repository from the workspace. A clone made by the
// server is deleted from disk; a locally-opened tree is left untouched
// (Configer never destroys a working tree it did not create).
// disconnect removes a repository from the workspace.
//
// @Summary     Disconnect a repository
// @Description Remove a repository from the workspace. A clone Configer made is deleted from disk; a locally-opened working tree is left untouched.
// @Tags        Workspace
// @Produce     json
// @Param       id path string true "Repository id"
// @Success     200 {object} map[string]interface{}
// @Failure     404 {object} APIError "Unknown repository"
// @Security    CookieSession
// @Router      /api/repos/{id} [delete]
func (h *Hub) disconnect(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !h.requireAppLifecycle(w, r, id, "disconnect this application") {
		return
	}
	// Dismiss a still-connecting or failed background entry (it is not in the
	// registry yet). Deleting a partial clone directory frees the disk.
	h.mu.Lock()
	if c, isConnecting := h.connecting[id]; isConnecting {
		delete(h.connecting, id)
		// A worker may still be copying into that folder. Deleting it underneath
		// git is how one dismissal turned into a failure on every attempt after
		// it; the worker sees the entry is gone and clears up after itself.
		running := h.cloning[id]
		h.mu.Unlock()
		if !c.Local && !running {
			_ = os.RemoveAll(filepath.Join(h.dataDir, "repos", id))
		}
		h.auditHub(r, id, "Dismissed connecting repository "+c.Name, "DELETE /repos/"+id)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": id})
		return
	}
	h.mu.Unlock()
	e, ok := h.registry.Remove(id)
	if !ok {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "unknown repository: "+id)
		return
	}
	h.mu.Lock()
	s := h.servers[id]
	delete(h.servers, id)
	delete(h.handlers, id)
	delete(h.errs, id)
	h.mu.Unlock()
	if s != nil {
		s.StopSync()
	}
	if h.index != nil {
		_ = h.index.RemoveApp(id)
	}
	if p := h.pathFor(e); !e.Local && strings.HasPrefix(p, filepath.Join(h.dataDir, "repos")+string(os.PathSeparator)) {
		_ = os.RemoveAll(p)
	}
	slog.Info("workspace disconnected repository", slog.String("id", id))
	h.auditHub(r, id, "Disconnected repository "+e.Name, "DELETE /repos/"+id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": id})
}
