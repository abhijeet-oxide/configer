// Package api exposes Configer's HTTP REST API.
//
// Reads serve the parameter grid straight from the managed Git working tree
// (fronted by the Postgres cache in a later phase). Writes are git-native:
// cell edits stage into a draft change request; submitting turns the draft
// into a branch + commit (+ hosted PR when configured); merging publishes.
package api

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/changeset"
	"github.com/abhijeet-oxide/configer/backend/internal/crstore"
	"github.com/abhijeet-oxide/configer/backend/internal/diff"
	"github.com/abhijeet-oxide/configer/backend/internal/gitengine"
	"github.com/abhijeet-oxide/configer/backend/internal/grid"
	"github.com/abhijeet-oxide/configer/backend/internal/ingest"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/parsers"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/provider"
	"github.com/abhijeet-oxide/configer/backend/internal/render"
	"github.com/abhijeet-oxide/configer/backend/internal/resolver"
	"github.com/abhijeet-oxide/configer/backend/internal/transposers"
	"github.com/abhijeet-oxide/configer/backend/internal/validate"
	"github.com/abhijeet-oxide/configer/backend/internal/writer"
)

// Server holds the wired services behind the HTTP surface.
type Server struct {
	RepoPath string
	Registry *plugin.Registry
	Git      *gitengine.Repo
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
	transposers.Register(reg)

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

	return &Server{
		RepoPath:    repoPath,
		Registry:    reg,
		Git:         repo,
		Store:       store,
		Changes:     &changeset.Service{Repo: repo, Store: store, Registry: reg, Provider: prov},
		Version:     getenv("CONFIGER_VERSION", "dev"),
		Environment: getenv("CONFIGER_ENV", "development"),
	}, nil
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
	mux.HandleFunc("GET /api/compare", s.compare)
	mux.HandleFunc("GET /api/render/{instance}", s.render)
	mux.HandleFunc("POST /api/scan", s.scan)
	mux.HandleFunc("GET /api/validation/presets", s.presets)
	mux.HandleFunc("PUT /api/values", s.stageValue)
	mux.HandleFunc("DELETE /api/values", s.revertValue)
	mux.HandleFunc("PUT /api/parameters/{id}", s.updateParameter)
	mux.HandleFunc("POST /api/parameters", s.addParameter)
	mux.HandleFunc("DELETE /api/parameters/{id}", s.deleteParameter)
	mux.HandleFunc("GET /api/changes", s.listChanges)
	mux.HandleFunc("GET /api/changes/draft", s.currentDraft)
	mux.HandleFunc("GET /api/changes/{id}", s.getChange)
	mux.HandleFunc("POST /api/changes/{id}/submit", s.submitChange)
	mux.HandleFunc("POST /api/changes/{id}/merge", s.mergeChange)
	mux.HandleFunc("POST /api/changes/{id}/reject", s.rejectChange)
	mux.HandleFunc("GET /api/repo/status", s.repoStatus)
	mux.HandleFunc("POST /api/repo/sync", s.repoSync)
	mux.HandleFunc("GET /api/meta", s.meta)
	mux.HandleFunc("GET /api/repo/findings", s.findings)
	mux.HandleFunc("POST /api/repo/findings/ack", s.ackFindings)
	mux.HandleFunc("POST /api/import", s.importParameters)
	mux.HandleFunc("POST /api/parameters/retire-file", s.retireFile)
	return mux
}

func (s *Server) load() (*project.Project, error) { return project.Load(s.RepoPath) }

// loadWithDraft loads the project and overlays the current draft's pending
// values so the grid reflects what the user will submit.
func (s *Server) loadWithDraft() (*project.Project, *change.ChangeRequest, error) {
	p, err := s.load()
	if err != nil {
		return nil, nil, err
	}
	draft := s.Store.CurrentDraft()
	if draft == nil {
		return p, nil, nil
	}
	for _, it := range draft.Items {
		if it.Scope == "global" {
			// Scope-level pending edit: preview it in the global overlay.
			if p.Scopes.Global == nil {
				p.Scopes.Global = map[string]any{}
			}
			if it.Act() == change.ActionSet {
				p.Scopes.Global[it.ParamID] = it.New
			} else {
				delete(p.Scopes.Global, it.ParamID)
			}
			continue
		}
		ov, ok := p.Overlays[it.Instance]
		if !ok {
			ov = model.Overlay{Kind: "Overlay", Instance: it.Instance, Values: map[string]any{}}
		}
		if ov.Values == nil {
			ov.Values = map[string]any{}
		}
		switch it.Act() {
		case change.ActionReset:
			delete(ov.Values, it.ParamID)
			dropExcl(&ov, it.ParamID)
		case change.ActionExclude:
			delete(ov.Values, it.ParamID)
			if !ov.Excludes(it.ParamID) {
				ov.Exclude = append(ov.Exclude, it.ParamID)
			}
		default:
			ov.Values[it.ParamID] = it.New
			dropExcl(&ov, it.ParamID)
		}
		p.Overlays[it.Instance] = ov
	}
	return p, draft, nil
}

func dropExcl(ov *model.Overlay, paramID string) {
	for i, id := range ov.Exclude {
		if id == paramID {
			ov.Exclude = append(ov.Exclude[:i], ov.Exclude[i+1:]...)
			return
		}
	}
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// meta identifies this deployment: shown in the UI footer and used for
// professional, environment-aware messaging (never "localhost" jargon).
func (s *Server) meta(w http.ResponseWriter, _ *http.Request) {
	branch, _ := s.Git.CurrentBranch()
	project := ""
	if p, err := s.load(); err == nil {
		project = p.Catalog.Metadata.Project
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

func (s *Server) projectInfo(w http.ResponseWriter, _ *http.Request) {
	p, _, err := s.loadWithDraft()
	if err != nil {
		writeErr(w, err)
		return
	}
	g := grid.Build(p)
	branch, _ := s.Git.CurrentBranch()
	writeJSON(w, http.StatusOK, map[string]any{
		"project":    g.Project,
		"instances":  g.Instances,
		"categories": g.Categories,
		"paramCount": len(g.Rows),
		"branch":     branch,
		"remote":     gitengine.Redact(s.Git.OriginURL()),
	})
}

func (s *Server) grid(w http.ResponseWriter, _ *http.Request) {
	p, draft, err := s.loadWithDraft()
	if err != nil {
		writeErr(w, err)
		return
	}
	g := grid.Build(p)
	if draft != nil {
		pending := map[string]map[string]bool{}
		globalPending := map[string]bool{}
		for _, it := range draft.Items {
			if it.Scope == "global" {
				globalPending[it.ParamID] = true
				continue
			}
			if pending[it.ParamID] == nil {
				pending[it.ParamID] = map[string]bool{}
			}
			pending[it.ParamID][it.Instance] = true
		}
		for i := range g.Rows {
			id := g.Rows[i].Param.ID
			for name, c := range g.Rows[i].Cells {
				if pending[id][name] {
					c.Pending = true
				}
				// A pending global edit shows on every cell that would take
				// it (i.e. not overridden at a more specific level).
				if globalPending[id] && (c.Source == model.ScopeGlobal || c.Source == model.ScopeDefault) {
					c.Pending = true
				}
				g.Rows[i].Cells[name] = c
			}
		}
	}
	writeJSON(w, http.StatusOK, g)
}

func (s *Server) instances(w http.ResponseWriter, _ *http.Request) {
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p.Registry)
}

func (s *Server) parameter(w http.ResponseWriter, r *http.Request) {
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	param, ok := p.ParamByID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "parameter not found"})
		return
	}
	writeJSON(w, http.StatusOK, param)
}

func (s *Server) compare(w http.ResponseWriter, r *http.Request) {
	p, _, err := s.loadWithDraft()
	if err != nil {
		writeErr(w, err)
		return
	}
	res, err := diff.CompareInstances(p, r.URL.Query().Get("left"), r.URL.Query().Get("right"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) render(w http.ResponseWriter, r *http.Request) {
	p, _, err := s.loadWithDraft()
	if err != nil {
		writeErr(w, err)
		return
	}
	files, err := render.Instance(p, r.PathValue("instance"), s.Registry)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"instance": r.PathValue("instance"), "files": files})
}

func (s *Server) scan(w http.ResponseWriter, _ *http.Request) {
	p, err := s.load()
	ignore := project.Ignore{}
	if err == nil {
		ignore = p.Ignore
	}
	res, err := ingest.Scan(s.RepoPath, s.Registry, ignore)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) presets(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, validate.Presets())
}

// stageValue is the validated write path for a cell edit. Actions:
//   - set (default): coerce to the declared type (lists per item), validate,
//     stage the override;
//   - reset: stage removal of the instance override (fall back to the chain);
//   - exclude: stage a tombstone; the parameter renders NOTHING in this
//     instance's generated files.
//
// Nothing touches Git until the draft is submitted.
func (s *Server) stageValue(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Instance string `json:"instance"`
		ParamID  string `json:"paramId"`
		// Scope "global" stages a scope-level edit that applies to every
		// instance not overriding at a more specific level ("change it for
		// everyone"). Instance is ignored then.
		Scope  string `json:"scope"`
		Value  any    `json:"value"`
		Action string `json:"action"`
		Author string `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Scope != "" && req.Scope != "global" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "only the global scope supports scope-level edits today"})
		return
	}
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	param, found := p.ParamByID(req.ParamID)
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "parameter not found"})
		return
	}

	action := change.Action(req.Action)
	if action == "" {
		action = change.ActionSet
	}
	if req.Scope == "global" && action == change.ActionExclude {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "exclusion is per-instance; a global value cannot be excluded"})
		return
	}
	var coerced any
	if action == change.ActionSet {
		coerced, err = validate.CoerceValue(param, req.Value)
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
			return
		}
		if vr := validate.Value(param, coerced); !vr.Valid {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": vr.Message})
			return
		}
	}

	// Baseline = the currently committed effective value.
	var oldVal any
	instance := req.Instance
	if req.Scope == "global" {
		instance = ""
		if v, ok := p.Scopes.Global[req.ParamID]; ok {
			oldVal = v
		} else {
			oldVal = param.Default
		}
	} else {
		inst, found := p.InstanceByName(req.Instance)
		if !found {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "instance not found"})
			return
		}
		res := (&resolver.Resolver{Scopes: p.Scopes, Instance: p.Overlays}).Resolve(param, inst)
		oldVal = res.Value
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	branch, _ := s.Git.CurrentBranch()
	author := req.Author
	if author == "" {
		author = "anonymous"
	}
	draft, err := s.Store.Draft(author, branch)
	if err != nil {
		writeErr(w, err)
		return
	}
	_, err = s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
		it := change.Item{ParamID: req.ParamID, Instance: instance, Scope: req.Scope, Action: action,
			Old: oldVal, New: coerced, UpdatedAt: time.Now().UTC()}
		cr.UpsertItem(it)
		// Setting a cell back to its committed value cancels the pending edit.
		if action == change.ActionSet {
			for _, existing := range cr.Items {
				if existing.ParamID == req.ParamID && existing.Instance == instance &&
					existing.Act() == change.ActionSet &&
					stringify(existing.Old) == stringify(coerced) {
					cr.RemoveItem(req.ParamID, instance)
					break
				}
			}
		}
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	d := s.Store.CurrentDraft()
	pending := 0
	changeID := draft.ID
	if d != nil {
		pending, changeID = len(d.Items), d.ID
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "value": coerced, "pending": pending, "changeId": changeID})
}

// revertValue drops one pending edit from the draft.
func (s *Server) revertValue(w http.ResponseWriter, r *http.Request) {
	paramID := r.URL.Query().Get("paramId")
	instance := r.URL.Query().Get("instance")
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	draft := s.Store.CurrentDraft()
	if draft == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no draft"})
		return
	}
	if _, err := s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
		cr.RemoveItem(paramID, instance)
		return nil
	}); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// updateParameter patches a parameter's data type and/or validation rules.
// Catalog metadata is an admin action committed directly to the target branch
// (with attribution), keeping the working tree consistent with Git.
func (s *Server) updateParameter(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Type        *model.ParamType  `json:"type,omitempty"`
		Validation  *model.Validation `json:"validation,omitempty"`
		DisplayName *string           `json:"displayName,omitempty"`
		Description *string           `json:"description,omitempty"`
		Category    *string           `json:"category,omitempty"`
		Scope       *model.Scope      `json:"scope,omitempty"`
		Secret      *bool             `json:"secret,omitempty"`
		Author      string            `json:"author,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Validation != nil && req.Validation.Preset != "" {
		if _, found := validate.PresetByID(req.Validation.Preset); !found {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "unknown preset rule"})
			return
		}
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	param, err := writer.UpdateParameter(s.RepoPath, r.PathValue("id"), writer.ParamPatch{
		Type:        req.Type,
		Validation:  req.Validation,
		DisplayName: req.DisplayName,
		Description: req.Description,
		Category:    req.Category,
		Scope:       req.Scope,
		Secret:      req.Secret,
	})
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	author := req.Author
	if author == "" {
		author = "anonymous"
	}
	msg := "Update parameter " + param.Name + "\n\nChanged-by: " + author + "\n"
	if _, err := s.Git.CommitAll(s.RepoPath, msg); err != nil && !strings.Contains(err.Error(), "nothing to commit") {
		writeErr(w, err)
		return
	} else if err == nil && s.Git.HasRemote() {
		branch, _ := s.Git.CurrentBranch()
		if perr := s.Git.Push(branch); perr != nil {
			log.Printf("warn: push rules update: %v", perr)
		}
	}
	writeJSON(w, http.StatusOK, param)
}

// addParameter creates a new catalog parameter from the GUI (e.g. an optional
// vendor key only some instances will carry). Committed directly with
// attribution, like other catalog metadata operations.
func (s *Server) addParameter(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Param  model.Parameter `json:"param"`
		Author string          `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	pm := req.Param
	if pm.Name == "" || pm.Source.File == "" || pm.Source.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name, source.file and source.path are required"})
		return
	}
	if pm.ID == "" {
		pm.ID = slugify(pm.Name)
	}
	if pm.Type == "" {
		pm.Type = model.TypeString
	}
	if pm.Scope == "" {
		pm.Scope = model.ScopeInstance
	}
	if pm.Category == "" {
		pm.Category = "Uncategorized"
	}
	if pm.Source.Format == "" {
		pm.Source.Format = formatForFile(pm.Source.File)
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := writer.AddParameter(s.RepoPath, pm); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	s.commitCatalogChange(w, "Add parameter "+pm.Name, req.Author, pm)
}

// deleteParameter retires a parameter everywhere: catalog entry removed,
// every overlay stripped, and all generated files re-rendered so the key /
// element disappears from every instance's output.
func (s *Server) deleteParameter(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Author string `json:"author"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	id := r.PathValue("id")

	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	param, found := p.ParamByID(id)
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "parameter not found"})
		return
	}
	names := make([]string, len(p.Registry.Instances))
	for i, inst := range p.Registry.Instances {
		names[i] = inst.Name
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := writer.DeleteParameter(s.RepoPath, id, names); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	// Drop any pending draft items for the retired parameter.
	if draft := s.Store.CurrentDraft(); draft != nil {
		_, _ = s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
			kept := cr.Items[:0]
			for _, it := range cr.Items {
				if it.ParamID != id {
					kept = append(kept, it)
				}
			}
			cr.Items = kept
			return nil
		})
	}
	s.commitCatalogChange(w, "Retire parameter "+param.Name, req.Author, map[string]any{"ok": true, "retired": id})
}

// commitCatalogChange regenerates every instance's generated/ files, commits
// the catalog operation with attribution, pushes, and writes the response.
func (s *Server) commitCatalogChange(w http.ResponseWriter, title, author string, response any) {
	if author == "" {
		author = "anonymous"
	}
	if p, err := s.load(); err == nil {
		for _, inst := range p.Registry.Instances {
			files, rerr := render.Instance(p, inst.Name, s.Registry)
			if rerr != nil {
				continue // a broken instance must not block the catalog op
			}
			for _, f := range files {
				out := filepath.Join(s.RepoPath, "generated", inst.Name, f.Path)
				if err := os.MkdirAll(filepath.Dir(out), 0o755); err == nil {
					_ = os.WriteFile(out, []byte(f.Content), 0o644)
				}
			}
		}
	}
	msg := title + "\n\nChanged-by: " + author + "\n"
	if _, err := s.Git.CommitAll(s.RepoPath, msg); err != nil && !strings.Contains(err.Error(), "nothing to commit") {
		writeErr(w, err)
		return
	} else if err == nil && s.Git.HasRemote() {
		branch, _ := s.Git.CurrentBranch()
		if perr := s.Git.Push(branch); perr != nil {
			log.Printf("warn: push catalog change: %v", perr)
		}
	}
	writeJSON(w, http.StatusOK, response)
}

func slugify(name string) string {
	s := strings.ToLower(name)
	s = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		default:
			return '-'
		}
	}, s)
	return strings.Trim(strings.Join(strings.FieldsFunc(s, func(r rune) bool { return r == '-' }), "-"), "-")
}

func formatForFile(file string) string {
	switch {
	case strings.HasSuffix(file, ".xml"):
		return "xml"
	case strings.HasSuffix(file, ".json"):
		return "json"
	default:
		return "yaml"
	}
}

// --- change request endpoints ---

func (s *Server) listChanges(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Store.List())
}

func (s *Server) currentDraft(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"draft": s.Store.CurrentDraft()})
}

func (s *Server) getChange(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid id"})
		return
	}
	cr, err := s.Changes.Refresh(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, cr)
}

func (s *Server) submitChange(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid id"})
		return
	}
	var req struct {
		Title       string `json:"title"`
		Description string `json:"description"`
		Reference   string `json:"reference"`
		Category    string `json:"category"`
		Author      string `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	cr, err := s.Changes.Submit(r.Context(), id, req.Title, req.Description, req.Author, req.Reference, req.Category)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, cr)
}

func (s *Server) mergeChange(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid id"})
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	cr, err := s.Changes.Merge(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, cr)
}

func (s *Server) rejectChange(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid id"})
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	cr, err := s.Changes.Reject(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, cr)
}

func stringify(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
}

// withCORS allows the Vite dev server (different port) to call the API.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
