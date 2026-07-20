package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/auth"
	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/crstore"
	"github.com/abhijeet-oxide/configer/backend/internal/gitengine"
	"github.com/abhijeet-oxide/configer/backend/internal/parsers"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/provider"
	"github.com/abhijeet-oxide/configer/backend/internal/remoterepo"
	"github.com/abhijeet-oxide/configer/backend/internal/repobackend"
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
	registry *workspace.Registry
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
}

// connecting is the transient state of a repository being connected in the
// background.
type connecting struct {
	ID      string
	Name    string
	Origin  string
	Local   bool
	Remote  bool
	AddedAt time.Time
	Status  string // "connecting" | "error"
	Error   string
}

// NewHub loads the workspace registry from dataDir and opens every connected
// repository. When the registry is empty and seed points at an existing
// directory, that directory is registered in place (CONFIGER_REPO keeps its
// meaning as the bootstrap repository).
func NewHub(dataDir, seed string, interval time.Duration) (*Hub, error) {
	reg, err := workspace.Load(dataDir)
	if err != nil {
		return nil, err
	}
	platform, authSvc, err := newPlatform(dataDir)
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
	}
	if authSvc.Enabled() {
		slog.Info("auth enabled: GitHub OAuth", slog.String("store", platform.Dialect()))
	} else {
		slog.Info("auth disabled: single-user mode", slog.String("store", platform.Dialect()))
	}
	if len(reg.List()) == 0 && seed != "" {
		if st, serr := os.Stat(seed); serr == nil && st.IsDir() {
			abs, _ := filepath.Abs(seed)
			name := workspace.NameFromURL(abs)
			e := workspace.Entry{
				ID: reg.UniqueID(workspace.Slug(name)), Name: name,
				Origin: abs, Path: abs, Local: true, AddedAt: time.Now().UTC(),
			}
			if aerr := reg.Add(e); aerr != nil {
				return nil, aerr
			}
			slog.Info("workspace seeded with local repository", slog.String("id", e.ID), slog.String("path", abs))
		}
	}
	for _, e := range reg.List() {
		if oerr := h.open(e); oerr != nil {
			slog.Warn("repository unavailable", slog.String("id", e.ID), slog.Any("error", oerr))
			h.errs[e.ID] = oerr.Error()
		}
	}
	return h, nil
}

// Count reports how many repositories are connected.
func (h *Hub) Count() int { return len(h.registry.List()) }

// open builds (or rebuilds) the per-repo server and starts its sync loop.
// Remote repositories are materialized through the API (no clone); cloned
// repositories whose working tree vanished (ephemeral disk) are re-cloned.
func (h *Hub) open(e workspace.Entry) error {
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
		var err error
		if s, err = New(e.Path); err != nil {
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
	store, err := crstore.New(filepath.Join(h.dataDir, "state", e.ID, "state.json"))
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

// defaultHandler serves the unscoped legacy routes: the first healthy
// repository in connection order.
func (h *Hub) defaultHandler() http.Handler {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, e := range h.registry.List() {
		if hd, ok := h.handlers[e.ID]; ok {
			return hd
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
	mux.HandleFunc("GET /api/github/branches", h.githubBranches)
	// Local-folder picker for the New Application flow (localhost mode).
	mux.HandleFunc("GET /api/fs/browse", h.browseFolders)
	mux.HandleFunc("GET /api/workspace", h.list)
	mux.HandleFunc("GET /api/repos", h.list)
	mux.HandleFunc("POST /api/repos", h.connect)
	mux.HandleFunc("PATCH /api/repos/{id}", h.rename)
	mux.HandleFunc("DELETE /api/repos/{id}", h.disconnect)
	mux.HandleFunc("GET /api/repos/{id}/members", h.members)
	mux.HandleFunc("PUT /api/repos/{id}/members", h.setMember)
	mux.HandleFunc("DELETE /api/repos/{id}/members/{login}", h.removeMember)
	mux.HandleFunc("/api/repos/{id}/", h.dispatch)
	mux.HandleFunc("/api/", h.legacy)
	return withObservability(withCORS(withBodyLimit(h.auth.Middleware(mux))), h.log())
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

// health is the liveness probe.
//
// @Summary     Liveness probe
// @Description Returns 200 while the process is up. `/api/healthz` is an alias. Used as a liveness check by load balancers and orchestrators; it does not check dependencies (see readiness).
// @Tags        Health
// @Produce     json
// @Success     200 {object} StatusResponse
// @Router      /api/health [get]
// @Router      /api/healthz [get]
func (h *Hub) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": h.Version})
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
	if h.defaultHandler() != nil {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
		return
	}
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "no repository connected"})
}

// dispatch rewrites /api/repos/{id}/<rest> to /api/<rest> and serves it with
// that repository's own handler, so every existing endpoint works per repo.
// Requests pass role enforcement first and land in the audit trail after.
func (h *Hub) dispatch(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	_, hd := h.server(id)
	if hd == nil {
		h.mu.Lock()
		reason := h.errs[id]
		h.mu.Unlock()
		msg := "unknown repository: " + id
		if reason != "" {
			msg = "repository " + id + " is unavailable: " + reason
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": msg})
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
}

func (h *Hub) legacy(w http.ResponseWriter, r *http.Request) {
	hd := h.defaultHandler()
	if hd == nil {
		writeJSON(w, http.StatusServiceUnavailable,
			map[string]string{"error": "no repository is connected yet; connect one via POST /api/repos"})
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
	// Status is "connecting" while a background clone/open runs, "error" when
	// it failed, and empty ("" = ready) for a fully connected repository. The
	// client polls the portfolio until it leaves "connecting".
	Status string `json:"status,omitempty"`
}

func (h *Hub) summarize(e workspace.Entry) RepoSummary {
	sum := RepoSummary{
		ID: e.ID, Name: e.Name, Origin: gitengine.Redact(e.Origin),
		Local: e.Local, NoClone: e.Remote, AddedAt: e.AddedAt,
	}
	s, _ := h.server(e.ID)
	if s == nil {
		h.mu.Lock()
		sum.Error = h.errs[e.ID]
		h.mu.Unlock()
		if sum.Error == "" {
			sum.Error = "repository is not available"
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
func (h *Hub) list(w http.ResponseWriter, _ *http.Request) {
	entries := h.registry.List()
	out := make([]RepoSummary, 0, len(entries))
	for _, e := range entries {
		out = append(out, h.summarize(e))
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

// connect starts connecting a repository and returns immediately. Cloning a
// large private repository can take tens of seconds; blocking the HTTP request
// on it times out behind proxies and makes a client retry start a second
// clone. Instead this validates synchronously, then does the clone/open in the
// background and answers 202 Accepted with a "connecting" summary. The client
// polls the portfolio (GET /repos) until the repository leaves "connecting"
// (ready) or shows status "error".
//
// @Summary     Connect a repository
// @Description Start connecting a repository (clone a git URL, manage no-clone when `mode:"remote"`, or open a local directory). Returns 202 with a `status:"connecting"` summary; poll GET /api/repos until it becomes ready or `status:"error"`. Connecting an already-connected or in-flight origin returns 409 with the existing id (idempotent by origin).
// @Tags        Workspace
// @Accept      json
// @Produce     json
// @Param       body body ConnectRequest true "Repository to connect"
// @Success     202 {object} RepoSummary "Connecting; poll the portfolio"
// @Failure     400 {object} APIError "Missing url"
// @Failure     409 {object} APIError "Already connected or connecting"
// @Security    CookieSession
// @Router      /api/repos [post]
func (h *Hub) connect(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL    string `json:"url"`
		Name   string `json:"name"`
		Branch string `json:"branch"`
		Token  string `json:"token"`
		// Mode "remote" manages the repository through the Git data API with
		// NO clone (materialized cache only); default clones as before.
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.URL) == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "url (git URL or local path) is required")
		return
	}
	req.URL = strings.TrimSpace(req.URL)

	// Idempotency by origin: the same origin connected twice would give two
	// divergent working trees of one truth. A connection that already exists,
	// or one already in flight, points the user at the existing id instead of
	// starting a duplicate.
	if id, name, ok := h.originInUse(req.URL); ok {
		writeJSON(w, http.StatusConflict, struct {
			APIError
			ID string `json:"id"`
		}{APIError{Error: "this repository is already connected as \"" + name + "\"", Code: CodeConflict, RequestID: reqID(r)}, id})
		return
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = workspace.NameFromURL(req.URL)
	}
	id := h.registry.UniqueID(workspace.Slug(name))

	// Determine the connection shape and resolve credentials synchronously
	// (they need the request); the slow clone/open happens in the background.
	st, statErr := os.Stat(req.URL)
	isDir := statErr == nil && st.IsDir()
	autoToken := false
	if req.Token == "" && !isDir {
		req.Token, _, _ = h.githubCred(r)
		autoToken = req.Token != ""
	}

	c := &connecting{ID: id, Name: name, Origin: req.URL, Local: isDir,
		Remote: req.Mode == "remote", AddedAt: time.Now().UTC(), Status: "connecting"}
	h.mu.Lock()
	h.connecting[id] = c
	h.mu.Unlock()
	h.auditHub(r, id, "Connecting repository "+name, "POST /repos")

	go h.connectWorker(connectSpec{
		id: id, name: name, url: req.URL, branch: req.Branch, token: req.Token,
		mode: req.Mode, isDir: isDir, autoToken: autoToken, addedAt: c.AddedAt,
	})
	writeJSON(w, http.StatusAccepted, connectingSummary(c))
}

// originInUse reports whether an origin is already connected or connecting.
func (h *Hub) originInUse(url string) (id, name string, ok bool) {
	want := gitengine.Redact(url)
	for _, e := range h.registry.List() {
		if gitengine.Redact(e.Origin) == want {
			return e.ID, e.Name, true
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range h.connecting {
		if c.Status == "connecting" && gitengine.Redact(c.Origin) == want {
			return c.ID, c.Name, true
		}
	}
	return "", "", false
}

// connectSpec carries everything the background worker needs (credentials are
// resolved on the request goroutine, before this runs).
type connectSpec struct {
	id, name, url, branch, token, mode string
	isDir, autoToken                   bool
	addedAt                            time.Time
}

// connectWorker performs the slow clone/open off the request path, then
// registers the repository or records the failure on the connecting entry.
func (h *Hub) connectWorker(sp connectSpec) {
	var e workspace.Entry
	switch {
	case sp.isDir:
		abs, _ := filepath.Abs(sp.url)
		e = workspace.Entry{ID: sp.id, Name: sp.name, Origin: abs, Path: abs,
			Branch: sp.branch, Local: true, AddedAt: sp.addedAt}
	case sp.mode == "remote":
		e = workspace.Entry{ID: sp.id, Name: sp.name, Origin: sp.url,
			Path: filepath.Join(h.dataDir, "repos", sp.id), Branch: sp.branch,
			Remote: true, Token: sp.token, AddedAt: sp.addedAt}
	default:
		gitName := getenv("CONFIGER_GIT_NAME", "Configer Bot")
		gitEmail := getenv("CONFIGER_GIT_EMAIL", "configer-bot@localhost")
		dir := filepath.Join(h.dataDir, "repos", sp.id)
		if _, cerr := gitengine.Clone(sp.url, dir, sp.branch, sp.token, gitName, gitEmail); cerr != nil {
			// An auto-supplied credential must never make things worse: if it
			// was rejected, retry once the anonymous (public) way.
			if sp.autoToken {
				_ = os.RemoveAll(dir)
				if _, cerr2 := gitengine.Clone(sp.url, dir, sp.branch, "", gitName, gitEmail); cerr2 == nil {
					cerr = nil
				}
			}
			if cerr != nil {
				h.failConnecting(sp.id, cerr.Error())
				return
			}
		}
		e = workspace.Entry{ID: sp.id, Name: sp.name, Origin: sp.url, Path: dir,
			Branch: sp.branch, AddedAt: sp.addedAt}
	}

	if err := h.open(e); err != nil {
		if !e.Local {
			_ = os.RemoveAll(e.Path)
		}
		h.failConnecting(sp.id, err.Error())
		return
	}
	if err := h.registry.Add(e); err != nil {
		h.failConnecting(sp.id, err.Error())
		return
	}
	h.mu.Lock()
	delete(h.connecting, sp.id)
	h.mu.Unlock()
	slog.Info("workspace connected repository", slog.String("id", e.ID), slog.String("origin", gitengine.Redact(e.Origin)))
}

// failConnecting records a background connection failure so the portfolio shows
// it (status "error") until the user dismisses it via DELETE /repos/{id}.
func (h *Hub) failConnecting(id, msg string) {
	h.mu.Lock()
	if c, ok := h.connecting[id]; ok {
		c.Status = "error"
		c.Error = msg
	}
	h.mu.Unlock()
	slog.Warn("workspace connect failed", slog.String("id", id), slog.String("error", msg))
}

// connectingSummary renders a transient connecting entry as a portfolio card.
func connectingSummary(c *connecting) RepoSummary {
	return RepoSummary{
		ID: c.ID, Name: c.Name, Origin: gitengine.Redact(c.Origin),
		Local: c.Local, NoClone: c.Remote, AddedAt: c.AddedAt,
		Status: c.Status, Error: c.Error,
	}
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
	// Dismiss a still-connecting or failed background entry (it is not in the
	// registry yet). Deleting a partial clone directory frees the disk.
	h.mu.Lock()
	if c, isConnecting := h.connecting[id]; isConnecting {
		delete(h.connecting, id)
		h.mu.Unlock()
		if !c.Local {
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
	if !e.Local && strings.HasPrefix(e.Path, filepath.Join(h.dataDir, "repos")+string(os.PathSeparator)) {
		_ = os.RemoveAll(e.Path)
	}
	slog.Info("workspace disconnected repository", slog.String("id", id))
	h.auditHub(r, id, "Disconnected repository "+e.Name, "DELETE /repos/"+id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": id})
}
