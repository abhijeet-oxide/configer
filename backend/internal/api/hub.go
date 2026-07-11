package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/crstore"
	"github.com/abhijeet-oxide/configer/backend/internal/gitengine"
	"github.com/abhijeet-oxide/configer/backend/internal/parsers"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/provider"
	"github.com/abhijeet-oxide/configer/backend/internal/remoterepo"
	"github.com/abhijeet-oxide/configer/backend/internal/repobackend"
	"github.com/abhijeet-oxide/configer/backend/internal/transposers"
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

	dataDir  string
	interval time.Duration
	registry *workspace.Registry

	mu       sync.Mutex
	servers  map[string]*Server
	handlers map[string]http.Handler
	errs     map[string]string // repos that failed to open, id -> reason
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
	h := &Hub{
		Version:     getenv("CONFIGER_VERSION", "dev"),
		Environment: getenv("CONFIGER_ENV", "development"),
		dataDir:     dataDir,
		interval:    interval,
		registry:    reg,
		servers:     map[string]*Server{},
		handlers:    map[string]http.Handler{},
		errs:        map[string]string{},
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
			log.Printf("workspace: seeded with local repository %s (%s)", e.ID, abs)
		}
	}
	for _, e := range reg.List() {
		if oerr := h.open(e); oerr != nil {
			log.Printf("warn: repository %s unavailable: %v", e.ID, oerr)
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
	transposers.Register(reg)

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

// Routes mounts the workspace surface plus per-repo dispatch.
func (h *Hub) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/workspace", h.list)
	mux.HandleFunc("GET /api/repos", h.list)
	mux.HandleFunc("POST /api/repos", h.connect)
	mux.HandleFunc("DELETE /api/repos/{id}", h.disconnect)
	mux.HandleFunc("/api/repos/{id}/", h.dispatch)
	mux.HandleFunc("/api/", h.legacy)
	return withCORS(mux)
}

// dispatch rewrites /api/repos/{id}/<rest> to /api/<rest> and serves it with
// that repository's own handler, so every existing endpoint works per repo.
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
	rest := strings.TrimPrefix(r.URL.Path, "/api/repos/"+id)
	r2 := r.Clone(r.Context())
	r2.URL.Path = "/api" + rest
	hd.ServeHTTP(w, r2)
}

func (h *Hub) legacy(w http.ResponseWriter, r *http.Request) {
	hd := h.defaultHandler()
	if hd == nil {
		writeJSON(w, http.StatusServiceUnavailable,
			map[string]string{"error": "no repository is connected yet; connect one via POST /api/repos"})
		return
	}
	hd.ServeHTTP(w, r)
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
	Params  int    `json:"params"`
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
	if p, err := s.load(); err == nil {
		sum.Project = p.Catalog.Metadata.Project
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

func (h *Hub) list(w http.ResponseWriter, _ *http.Request) {
	entries := h.registry.List()
	out := make([]RepoSummary, 0, len(entries))
	for _, e := range entries {
		out = append(out, h.summarize(e))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name":        "Configer",
		"version":     h.Version,
		"environment": h.Environment,
		"repos":       out,
	})
}

// connect registers a new repository: a git URL is cloned into the data
// directory (optionally authenticated); an existing local directory is
// opened in place.
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
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "url (git URL or local path) is required"})
		return
	}
	req.URL = strings.TrimSpace(req.URL)

	// The same origin connected twice would give two divergent working
	// trees of one truth; point the user at the existing connection.
	for _, e := range h.registry.List() {
		if gitengine.Redact(e.Origin) == gitengine.Redact(req.URL) {
			writeJSON(w, http.StatusConflict, map[string]string{
				"error": "this repository is already connected as \"" + e.Name + "\"",
				"id":    e.ID,
			})
			return
		}
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = workspace.NameFromURL(req.URL)
	}
	id := h.registry.UniqueID(workspace.Slug(name))

	var e workspace.Entry
	switch {
	case func() bool { st, err := os.Stat(req.URL); return err == nil && st.IsDir() }():
		abs, _ := filepath.Abs(req.URL)
		e = workspace.Entry{ID: id, Name: name, Origin: abs, Path: abs,
			Branch: req.Branch, Local: true, AddedAt: time.Now().UTC()}
	case req.Mode == "remote":
		// No clone: manage entirely through the Git data API. Path is the
		// materialized read cache the engine reads.
		e = workspace.Entry{ID: id, Name: name, Origin: req.URL,
			Path: filepath.Join(h.dataDir, "repos", id), Branch: req.Branch,
			Remote: true, Token: req.Token, AddedAt: time.Now().UTC()}
	default:
		gitName := getenv("CONFIGER_GIT_NAME", "Configer Bot")
		gitEmail := getenv("CONFIGER_GIT_EMAIL", "configer-bot@localhost")
		dir := filepath.Join(h.dataDir, "repos", id)
		if _, cerr := gitengine.Clone(req.URL, dir, req.Branch, req.Token, gitName, gitEmail); cerr != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": cerr.Error()})
			return
		}
		e = workspace.Entry{ID: id, Name: name, Origin: req.URL, Path: dir,
			Branch: req.Branch, AddedAt: time.Now().UTC()}
	}

	if err := h.open(e); err != nil {
		if !e.Local {
			_ = os.RemoveAll(e.Path)
		}
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}
	if err := h.registry.Add(e); err != nil {
		writeErr(w, err)
		return
	}
	log.Printf("workspace: connected repository %s (%s)", e.ID, gitengine.Redact(e.Origin))
	writeJSON(w, http.StatusOK, h.summarize(e))
}

// disconnect removes a repository from the workspace. A clone made by the
// server is deleted from disk; a locally-opened tree is left untouched
// (Configer never destroys a working tree it did not create).
func (h *Hub) disconnect(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	e, ok := h.registry.Remove(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown repository: " + id})
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
	log.Printf("workspace: disconnected repository %s", id)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": id})
}
