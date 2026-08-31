package api

// Parameter catalog mutations. Editing a parameter's own metadata - its rules,
// its scope, its default, the files it is bound to - STAGES into the caller's
// draft and travels the ordinary road: draft, review, publish. Creating and
// retiring a parameter are still administrative and commit directly.

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/validate"
	"github.com/abhijeet-oxide/configer/backend/internal/writer"
)

// updateParameter STAGES a patch to a parameter's own metadata on the caller's
// draft.
//
// It used to write .configer/parameters.yaml and commit it on the spot. That is
// fine on one person's laptop and impossible anywhere the repository protects
// its default branch: the push was refused, and it was refused AFTER the form
// had said the rules were saved. It is also the wrong shape - a validation rule
// decides what everybody else may type into a cell, which is exactly the sort of
// change a second person should see before it lands.
//
// So it is a change like any other. Nothing moves until the draft is submitted,
// reviewed and published, and the review names the fields that moved (see
// changeset.structuralSummary) with the catalog's own diff beside them.
//
// @Summary     Stage a parameter update
// @Description Stage a patch to a parameter's type, validation, display name, description, category, scope, secret flag, default, derived expression or file bindings. Nil fields are left unchanged. Staged on the caller's draft change request and written to `.configer/parameters.yaml` when that change is submitted and published - nothing touches Git here. The response carries the parameter as it WILL read once the change lands.
// @Tags        Grid & parameters
// @Accept      json
// @Produce     json
// @Param       id       path   string true "Parameter id (slug)"
// @Param       body     body object true "Partial parameter patch"
// @Success     200 {object} model.Parameter
// @Failure     400 {object} APIError "Malformed body or half-specified binding"
// @Failure     404 {object} APIError "Unknown parameter"
// @Failure     422 {object} APIError "Unknown validation preset"
// @Security    CookieSession
// @Router      /api/parameters/{id} [put]
func (s *Server) updateParameter(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Type        *model.ParamType  `json:"type,omitempty"`
		ItemType    *model.ParamType  `json:"itemType,omitempty"`
		Validation  *model.Validation `json:"validation,omitempty"`
		DisplayName *string           `json:"displayName,omitempty"`
		Description *string           `json:"description,omitempty"`
		Category    *string           `json:"category,omitempty"`
		Scope       *model.Scope      `json:"scope,omitempty"`
		Secret      *bool             `json:"secret,omitempty"`
		Default     *any              `json:"default,omitempty"`
		Derived     *string           `json:"derived,omitempty"`
		// Bindings attaches a design-phase parameter to real file locations
		// (or re-maps an existing one). Always set through the interactive
		// picker, never free text.
		Bindings *[]model.Binding `json:"bindings,omitempty"`
		Author   string           `json:"author,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
		return
	}
	if req.Validation != nil && req.Validation.Preset != "" {
		if _, found := validate.PresetByID(req.Validation.Preset); !found {
			writeError(w, r, http.StatusUnprocessableEntity, CodeValidationFailed, "unknown preset rule")
			return
		}
	}
	if req.Bindings != nil {
		bs := *req.Bindings
		for i := range bs {
			if bs[i].File == "" || bs[i].Path == "" {
				writeError(w, r, http.StatusBadRequest, CodeBadRequest, "attaching requires both the file and the path")
				return
			}
			if bs[i].Format == "" {
				bs[i].Format = formatForFile(bs[i].File)
			}
		}
		req.Bindings = &bs
	}

	id := r.PathValue("id")
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	current, found := p.ParamByID(id)
	if !found {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "parameter not found")
		return
	}
	patch := writer.ParamPatch{
		Type:        req.Type,
		ItemType:    req.ItemType,
		Validation:  req.Validation,
		DisplayName: req.DisplayName,
		Description: req.Description,
		Category:    req.Category,
		Scope:       req.Scope,
		Secret:      req.Secret,
		Default:     req.Default,
		Derived:     req.Derived,
		Bindings:    req.Bindings,
	}
	// A patch that asks for nothing the catalog does not already say is not a
	// change, and staging it would put a row in somebody's review that reads
	// "update admin.port" and contains no difference at all. Typing a value back
	// the way it was cancels a cell edit; the same has to be true here.
	narrowed, differs := narrowPatch(current, patch)
	if !differs {
		// Nothing left to say. Any metadata edit already staged for this
		// parameter is withdrawn - putting the form back the way it was is how
		// somebody undoes one.
		defer s.lockDraft(draftOwner(r))()
		if draft := s.Store.CurrentDraft(draftOwner(r)); draft != nil {
			_, _ = s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
				cr.RemoveItemKind(id, "", change.ActionUpdateParameter)
				return nil
			})
			s.dropEmptyDraft(draftOwner(r))
		}
		writeJSON(w, http.StatusOK, current)
		return
	}
	patch = narrowed
	preview := writer.ApplyPatch(current, patch)

	defer s.lockDraft(draftOwner(r))()
	draft, err := s.Store.Draft(draftOwner(r), s.branch())
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, err := s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
		cr.UpsertItem(change.Item{
			ParamID: id, Action: change.ActionUpdateParameter,
			// Old is the parameter's NAME, so a review still reads as the
			// setting long after the entry it describes has been rewritten.
			Old: current.Name, New: patch, UpdatedAt: time.Now().UTC(),
		})
		return nil
	}); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

// narrowPatch drops the fields a patch would not actually change, and reports
// whether anything is left. It is what keeps "save" idempotent: a form posts
// every field it holds, and eleven of the twelve are usually untouched.
func narrowPatch(cur model.Parameter, patch writer.ParamPatch) (writer.ParamPatch, bool) {
	out := writer.ParamPatch{}
	changed := false
	keep := func(differs bool, apply func()) {
		if differs {
			changed = true
			apply()
		}
	}
	keep(patch.Type != nil && *patch.Type != cur.Type, func() { out.Type = patch.Type })
	keep(patch.ItemType != nil && *patch.ItemType != cur.ItemType, func() { out.ItemType = patch.ItemType })
	keep(patch.DisplayName != nil && *patch.DisplayName != cur.DisplayName, func() { out.DisplayName = patch.DisplayName })
	keep(patch.Description != nil && *patch.Description != cur.Description, func() { out.Description = patch.Description })
	keep(patch.Category != nil && *patch.Category != cur.Category, func() { out.Category = patch.Category })
	keep(patch.Scope != nil && *patch.Scope != cur.Scope, func() { out.Scope = patch.Scope })
	keep(patch.Secret != nil && *patch.Secret != cur.Secret, func() { out.Secret = patch.Secret })
	keep(patch.Derived != nil && *patch.Derived != cur.Derived, func() { out.Derived = patch.Derived })
	keep(patch.Default != nil && stringify(*patch.Default) != stringify(cur.Default), func() { out.Default = patch.Default })
	keep(patch.Validation != nil && !sameJSON(*patch.Validation, cur.Validation), func() { out.Validation = patch.Validation })
	keep(patch.Bindings != nil && !sameJSON(*patch.Bindings, cur.Bindings), func() { out.Bindings = patch.Bindings })
	return out, changed
}

// sameJSON compares two values by their JSON rendering, which is how the draft
// store carries them anyway.
func sameJSON(a, b any) bool {
	x, err1 := json.Marshal(a)
	y, err2 := json.Marshal(b)
	return err1 == nil && err2 == nil && string(x) == string(y)
}

// addParameter creates a new catalog parameter from the GUI (e.g. an optional
// vendor key only some instances will carry). Committed directly with
// attribution, like other catalog metadata operations.
//
// @Summary     Create a parameter
// @Description Create a new catalog parameter. Bindings may be empty for a design-phase parameter (attached later), but a half-specified binding is rejected. Committed directly with attribution.
// @Tags        Grid & parameters
// @Accept      json
// @Produce     json
// @Param       body body object true "{param: Parameter, author?: string}"
// @Success     201 {object} model.Parameter
// @Header      201 {string} Location "URL of the created parameter"
// @Failure     400 {object} APIError "Malformed body, missing name, or half-specified binding"
// @Failure     409 {object} APIError "A parameter with that id already exists"
// @Security    CookieSession
// @Router      /api/parameters [post]
func (s *Server) addParameter(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Param  model.Parameter `json:"param"`
		Author string          `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
		return
	}
	pm := req.Param
	if pm.Name == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "name is required")
		return
	}
	// A parameter may be created in the design phase, before its
	// configuration file exists: bindings stay empty and are attached later.
	// But a half-specified binding is always a mistake.
	for i := range pm.Bindings {
		if pm.Bindings[i].File == "" || pm.Bindings[i].Path == "" {
			writeError(w, r, http.StatusBadRequest, CodeBadRequest, "every binding needs both a file and a path; leave bindings empty for a design-phase parameter")
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

	s.treeMu.Lock()
	defer s.treeMu.Unlock()
	if err := writer.AddParameter(s.RepoPath, pm); err != nil {
		writeError(w, r, http.StatusConflict, CodeConflict, err.Error())
		return
	}
	loc := strings.TrimSuffix(r.URL.Path, "/") + "/" + pm.ID
	s.commitCatalogCreate(w, r, "Add parameter "+pm.Name, req.Author, loc, pm)
}

// deleteParameter retires a parameter everywhere: the catalog entry is
// removed and the bound key/element is deleted from every real file it lives
// in, so the setting disappears from the whole repository.
//
// @Summary     Delete a parameter
// @Description Retire a parameter everywhere: the catalog entry is removed and the bound key/element is deleted from every real file it lives in. Committed directly with attribution.
// @Tags        Grid & parameters
// @Produce     json
// @Param       id path string true "Parameter id (slug)"
// @Success     200 {object} OKResponse
// @Failure     404 {object} APIError "Unknown parameter"
// @Failure     409 {object} APIError "Deletion failed"
// @Security    CookieSession
// @Router      /api/parameters/{id} [delete]
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
		writeError(w, r, http.StatusNotFound, CodeNotFound, "parameter not found")
		return
	}
	// Both locks: this edits .configer AND rewrites the caller's draft. Tree
	// first, then draft, which is the order every path needing both uses.
	s.treeMu.Lock()
	defer s.treeMu.Unlock()
	defer s.lockDraft(draftOwner(r))()
	if err := writer.DeleteParameter(s.RepoPath, id, p.Registry.Instances); err != nil {
		writeError(w, r, http.StatusConflict, CodeConflict, err.Error())
		return
	}
	// Drop any pending draft items for the retired parameter.
	if draft := s.Store.CurrentDraft(draftOwner(r)); draft != nil {
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
	s.commitCatalogChange(w, r, "Retire parameter "+param.Name, req.Author, map[string]any{"ok": true, "retired": id})
}

// unmanageParameter STAGES "stop managing this parameter" on the caller's
// draft. It is a change like any other - it rewrites .configer/parameters.yaml
// on the branch - so it travels the same road: draft, review, publish. Nothing
// happens to the catalog here; the item applies when the change is submitted.
//
// @Summary     Stage "stop managing" a parameter
// @Description Stage a pending change that removes a parameter from .configer/parameters.yaml and records its paths in .configer/ignore.yaml, so Configer stops showing it and a later scan does not propose it again. The repository's own configuration files are NOT touched: every value stays where it is. Staged on the current draft and applied when that change is submitted and published, like every other edit. Compare DELETE /api/parameters/{id}, which retires a parameter and deletes its value from every file.
// @Tags        Grid & parameters
// @Accept      json
// @Produce     json
// @Param       id path string true "Parameter id (slug)"
// @Success     200 {object} object "Staged; pending is the draft's item count"
// @Failure     404 {object} APIError "Unknown parameter"
// @Security    CookieSession
// @Router      /api/parameters/{id}/unmanage [post]
func (s *Server) unmanageParameter(w http.ResponseWriter, r *http.Request) {
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
		writeError(w, r, http.StatusNotFound, CodeNotFound, "parameter not found")
		return
	}

	defer s.lockDraft(draftOwner(r))()
	draft, err := s.Store.Draft(draftOwner(r), s.branch())
	if err != nil {
		writeErr(w, err)
		return
	}
	pending := 0
	if _, err := s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
		// A pending edit to a parameter this change stops managing would be
		// applied and then orphaned, so it goes with it.
		kept := cr.Items[:0]
		for _, it := range cr.Items {
			if it.ParamID != id {
				kept = append(kept, it)
			}
		}
		cr.Items = kept
		cr.UpsertItem(change.Item{
			ParamID: id, Action: change.ActionUnmanageParameter,
			Old: param.Name, New: param.Name, UpdatedAt: time.Now().UTC(),
		})
		pending = len(cr.Items)
		return nil
	}); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "staged": id, "pending": pending, "changeId": draft.ID,
	})
}
