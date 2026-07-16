package api

// Application identity: the display name, description and free-form metadata
// stored in .configer/application.yaml. Like every other .configer write this
// is committed to Git with attribution - the repository stays the single
// source of truth for what the application is.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/writer"
)

// getApplication returns the application identity from the working tree.
func (s *Server) getApplication(w http.ResponseWriter, _ *http.Request) {
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p.App)
}

// updateApplication patches the application's name, description and metadata
// and commits .configer/application.yaml. Nil fields are left unchanged; the
// layout is never editable here (it describes the repository, not the user).
func (s *Server) updateApplication(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        *string            `json:"name,omitempty"`
		Description *string            `json:"description,omitempty"`
		Metadata    *map[string]string `json:"metadata,omitempty"`
		Author      string             `json:"author,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Name != nil && strings.TrimSpace(*req.Name) == "" {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "the application name cannot be empty"})
		return
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	app := p.App
	if req.Name != nil {
		app.Name = strings.TrimSpace(*req.Name)
	}
	if req.Description != nil {
		app.Description = strings.TrimSpace(*req.Description)
	}
	if req.Metadata != nil {
		md := map[string]string{}
		for k, v := range *req.Metadata {
			k, v = strings.TrimSpace(k), strings.TrimSpace(v)
			if k != "" && v != "" {
				md[k] = v
			}
		}
		if len(md) == 0 {
			md = nil
		}
		app.Metadata = md
	}
	if err := writer.WriteApplication(s.RepoPath, app); err != nil {
		writeErr(w, err)
		return
	}
	s.commitCatalogChange(w, "Update application details", author(r, req.Author), app)
}

// deinit removes the .configer folder - Configer's metadata - from the
// repository and commits the removal, returning the repository to an
// unmanaged (un-onboarded) state. The repository's own configuration files
// are untouched; only the .configer directory is deleted.
func (s *Server) deinit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Author string `json:"author,omitempty"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	dir := filepath.Join(s.RepoPath, ".configer")
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": false})
		return
	}
	if err := os.RemoveAll(dir); err != nil {
		writeErr(w, err)
		return
	}
	s.commitCatalogChange(w, "Remove Configer metadata (.configer)", author(r, req.Author), map[string]any{"ok": true, "removed": true})
}
