package api

// Onboarding: discovery proposes an application from an existing repository
// (read-only); initialization writes the accepted proposal into .configer/ as
// ONE attributed commit — reviewable history from the very first action.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"

	"github.com/abhijeet-oxide/configer/backend/internal/discovery"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/writer"
)

// initialized reports whether the repository already carries a Configer
// application (.configer/parameters.yaml).
func (s *Server) initialized() bool {
	_, err := os.Stat(filepath.Join(s.RepoPath, ".configer", "parameters.yaml"))
	return err == nil
}

// discover runs layout detection + parameter discovery and returns the
// proposal. Read-only: nothing is written until /api/init.
func (s *Server) discover(w http.ResponseWriter, _ *http.Request) {
	ignore := discovery.Ignore{}
	if p, err := s.load(); err == nil {
		ignore = p.Ignore
	}
	res, err := discovery.Discover(s.RepoPath, s.Registry, ignore)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// initApp writes the accepted proposal to .configer/ and commits it.
func (s *Server) initApp(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string            `json:"name"`
		Description string            `json:"description"`
		Layout      string            `json:"layout"`
		Instances   []model.Instance  `json:"instances"`
		Parameters  []model.Parameter `json:"parameters"`
		IgnoreFiles []string          `json:"ignoreFiles"`
		Author      string            `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "an application name is required"})
		return
	}
	if len(req.Instances) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "at least one instance is required"})
		return
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.initialized() {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "this repository is already initialized; use the import wizard to add more parameters"})
		return
	}

	if err := writer.WriteApplication(s.RepoPath, model.Application{
		Name:        req.Name,
		Description: req.Description,
		Layout:      req.Layout,
	}); err != nil {
		writeErr(w, err)
		return
	}
	// Batch the writes: one instances.yaml write and one parameters.yaml write,
	// not one per entry. Onboarding a large GitOps repo (thousands of settings)
	// used to rewrite the catalog file once per parameter (O(n²)); this makes
	// it a single mutation, so initialization is fast.
	for i := range req.Instances {
		if req.Instances[i].Status == "" {
			req.Instances[i].Status = "active"
		}
	}
	if err := writer.AddInstances(s.RepoPath, req.Instances); err != nil {
		writeErr(w, err)
		return
	}
	valid := make([]model.Parameter, 0, len(req.Parameters))
	var skipped []string
	for _, pm := range req.Parameters {
		if pm.ID == "" || pm.Name == "" || len(pm.Bindings) == 0 {
			skipped = append(skipped, pm.Name)
			continue
		}
		if pm.Category == "" {
			pm.Category = "General"
		}
		if pm.Type == "" {
			pm.Type = model.TypeString
		}
		if pm.Scope == "" {
			pm.Scope = model.ScopeInstance
		}
		valid = append(valid, pm)
	}
	added, dropped, err := writer.AddParameters(s.RepoPath, valid)
	if err != nil {
		writeErr(w, err)
		return
	}
	skipped = append(skipped, dropped...)
	if len(req.IgnoreFiles) > 0 {
		if err := writer.AddIgnoreFiles(s.RepoPath, req.IgnoreFiles); err != nil {
			writeErr(w, err)
			return
		}
	}

	s.commitCatalogChange(w, "Initialize application "+req.Name, author(r, req.Author), map[string]any{
		"ok": true, "parameters": added, "instances": len(req.Instances), "skipped": skipped,
	})
}
