package api

// The validated value write path: cell edits stage into the draft change
// request; nothing touches Git until the draft is submitted.

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/resolver"
	"github.com/abhijeet-oxide/configer/backend/internal/validate"
)

// stageValue is the validated write path for a cell edit. Actions:
//   - set (default): coerce to the declared type (lists per item), validate,
//     stage the override;
//   - reset: stage removal of the instance override (fall back to the chain);
//   - exclude: stage removal of the key from the instance's files entirely.
//
// Nothing touches Git until the draft is submitted.
//
// @Summary     Stage a value edit
// @Description Stage a validated cell edit into the draft change request. The value is coerced to the parameter's declared type and validated; nothing touches Git until the draft is submitted. `action` defaults to "set"; "reset" drops the instance override; "exclude" removes the key from the instance's files. `scope:"global"` edits the shared value for every instance.
// @Tags        Editing & change requests
// @Accept      json
// @Produce     json
// @Param       body body ValueEditRequest true "The edit"
// @Success     200 {object} ValueStagedResponse
// @Failure     400 {object} APIError "Malformed body or unsupported scope"
// @Failure     404 {object} APIError "Parameter or instance not found"
// @Failure     422 {object} APIError "Value failed coercion or validation"
// @Failure     500 {object} APIError
// @Security    CookieSession
// @Router      /api/values [put]
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
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
		return
	}
	if req.Scope != "" && req.Scope != "global" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "only the global scope supports scope-level edits today")
		return
	}
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	param, found := p.ParamByID(req.ParamID)
	if !found {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "parameter not found")
		return
	}

	action := change.Action(req.Action)
	if action == "" {
		action = change.ActionSet
	}
	if req.Scope == "global" && action == change.ActionExclude {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "exclusion is per-instance; a global value cannot be excluded")
		return
	}
	var coerced any
	if action == change.ActionSet {
		coerced, err = validate.CoerceValue(param, req.Value)
		if err != nil {
			writeFieldErrors(w, r, "the value is not valid for this parameter", FieldError{Field: "value", Message: err.Error()})
			return
		}
		if vr := validate.Value(param, coerced); !vr.Valid {
			writeFieldErrors(w, r, "the value is not valid for this parameter", FieldError{Field: "value", Message: vr.Message})
			return
		}
	}

	// Baseline = the currently committed effective value, read from the
	// repository's real files.
	var oldVal any
	instance := req.Instance
	if req.Scope == "global" {
		instance = ""
		if len(param.BindingsOn(model.LayerBase, model.Instance{})) == 0 {
			writeError(w, r, http.StatusUnprocessableEntity, CodeValidationFailed, "this parameter has no shared file location; edit it per instance")
			return
		}
		res := resolver.New(p.Root).Resolve(param, model.Instance{})
		oldVal = res.Value
	} else {
		inst, found := p.InstanceByName(req.Instance)
		if !found {
			writeError(w, r, http.StatusNotFound, CodeNotFound, "instance not found")
			return
		}
		if action == change.ActionSet && len(param.BindingsOn(model.LayerInstance, inst)) == 0 {
			writeError(w, r, http.StatusUnprocessableEntity, CodeValidationFailed, "this parameter lives only in a shared file; use a global edit to change it for everyone")
			return
		}
		res := resolver.New(p.Root).Resolve(param, inst)
		oldVal = res.Value
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	draft, err := s.Store.Draft(author(r, req.Author), s.branch())
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
//
// @Summary     Revert a pending value edit
// @Description Drop one pending edit (identified by paramId + instance) from the current draft.
// @Tags        Editing & change requests
// @Produce     json
// @Param       paramId  query string true "Parameter id"
// @Param       instance query string true "Instance name (empty for a global edit)"
// @Success     200 {object} OKResponse
// @Failure     404 {object} APIError "No draft"
// @Failure     500 {object} APIError
// @Security    CookieSession
// @Router      /api/values [delete]
func (s *Server) revertValue(w http.ResponseWriter, r *http.Request) {
	paramID := r.URL.Query().Get("paramId")
	instance := r.URL.Query().Get("instance")
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	draft := s.Store.CurrentDraft()
	if draft == nil {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "no draft")
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
