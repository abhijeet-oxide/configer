package api

// Parameter catalog mutations: metadata is an admin action committed directly
// to the target branch with attribution, keeping the tree consistent with Git.

import (
	"encoding/json"
	"net/http"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/validate"
	"github.com/abhijeet-oxide/configer/backend/internal/writer"
)

// updateParameter patches a parameter's data type and/or validation rules.
func (s *Server) updateParameter(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Type        *model.ParamType  `json:"type,omitempty"`
		Validation  *model.Validation `json:"validation,omitempty"`
		DisplayName *string           `json:"displayName,omitempty"`
		Description *string           `json:"description,omitempty"`
		Category    *string           `json:"category,omitempty"`
		Scope       *model.Scope      `json:"scope,omitempty"`
		Secret      *bool             `json:"secret,omitempty"`
		Default     *any              `json:"default,omitempty"`
		// Bindings attaches a design-phase parameter to real file locations
		// (or re-maps an existing one). Always set through the interactive
		// picker, never free text.
		Bindings *[]model.Binding `json:"bindings,omitempty"`
		Author   string           `json:"author,omitempty"`
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
	if req.Bindings != nil {
		bs := *req.Bindings
		for i := range bs {
			if bs[i].File == "" || bs[i].Path == "" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "attaching requires both the file and the path"})
				return
			}
			if bs[i].Format == "" {
				bs[i].Format = formatForFile(bs[i].File)
			}
		}
		req.Bindings = &bs
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
		Default:     req.Default,
		Bindings:    req.Bindings,
	})
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	title := "Update parameter " + param.Name
	if req.Bindings != nil && len(param.Bindings) > 0 {
		title = "Attach parameter " + param.Name + " to " + param.Bindings[0].File
	}
	s.commitCatalogChange(w, title, req.Author, param)
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
	if pm.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}
	// A parameter may be created in the design phase, before its
	// configuration file exists: bindings stay empty and are attached later.
	// But a half-specified binding is always a mistake.
	for i := range pm.Bindings {
		if pm.Bindings[i].File == "" || pm.Bindings[i].Path == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "every binding needs both a file and a path; leave bindings empty for a design-phase parameter"})
			return
		}
		if pm.Bindings[i].Format == "" {
			pm.Bindings[i].Format = formatForFile(pm.Bindings[i].File)
		}
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

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := writer.AddParameter(s.RepoPath, pm); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	s.commitCatalogChange(w, "Add parameter "+pm.Name, req.Author, pm)
}

// deleteParameter retires a parameter everywhere: the catalog entry is
// removed and the bound key/element is deleted from every real file it lives
// in, so the setting disappears from the whole repository.
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
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := writer.DeleteParameter(s.RepoPath, id, p.Registry.Instances); err != nil {
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
