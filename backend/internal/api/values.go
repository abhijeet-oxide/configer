package api

// The validated value write path: cell edits stage into the draft change
// request; nothing touches Git until the draft is submitted.

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/grid"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/resolver"
	"github.com/abhijeet-oxide/configer/backend/internal/validate"
)

// draftInstance resolves an instance that exists only in the caller's draft: one
// staged by an add-instance item, not yet in the registry. Submit scaffolds the
// folder BEFORE applying value edits (see changeset.applyDraft), so editing a
// cell on a pending instance is legitimate - the edit simply lands in a folder
// that does not exist yet. The folder is derived exactly as the grid preview
// derives it, so the column the user is editing and the file the edit will
// reach are the same place.
//
// It also reports the clone source, because that - not "absent" - is the
// baseline a cloned instance's value is changing FROM: scaffolding copies the
// source folder, then the value edit refines it.
func draftInstance(draft *change.ChangeRequest, p *project.Project, name string) (inst model.Instance, cloneFrom string, ok bool) {
	if draft == nil {
		return model.Instance{}, "", false
	}
	for _, it := range draft.Items {
		if it.Act() != change.ActionAddInstance || it.Instance != name {
			continue
		}
		var meta model.Instance
		if b, err := json.Marshal(it.New); err == nil {
			_ = json.Unmarshal(b, &meta)
		}
		meta.Name = name
		src, _ := it.Old.(string)
		if meta.Folder == "" {
			meta.Folder = grid.PendingInstanceFolder(p.Registry.Instances, src, name)
		}
		return meta, src, true
	}
	return model.Instance{}, "", false
}

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
	relInst := model.Instance{}
	if req.Scope == "global" {
		instance = ""
		if len(param.BindingsOn(model.LayerBase, model.Instance{})) == 0 {
			writeError(w, r, http.StatusUnprocessableEntity, CodeValidationFailed, "this parameter has no shared file location; edit it per instance")
			return
		}
		res := s.resolve(p).Resolve(param, model.Instance{})
		oldVal = res.Value
	} else {
		inst, found := p.InstanceByName(req.Instance)
		// An instance staged in this draft has no registry entry yet; it is
		// still a real editing target (see draftInstance).
		baseline := inst
		if !found {
			var cloneFrom string
			inst, cloneFrom, found = draftInstance(s.Store.CurrentDraft(draftOwner(r)), p, req.Instance)
			if !found {
				writeError(w, r, http.StatusNotFound, CodeNotFound, "instance not found")
				return
			}
			// Its files do not exist yet, so the value this edit changes FROM is
			// whatever the clone source holds (scaffolding copies it first).
			baseline, _ = p.InstanceByName(cloneFrom)
		}
		if action == change.ActionSet && len(param.BindingsOn(model.LayerInstance, inst)) == 0 {
			writeError(w, r, http.StatusUnprocessableEntity, CodeValidationFailed, "this parameter lives only in a shared file; use a global edit to change it for everyone")
			return
		}
		res := s.resolve(p).Resolve(param, baseline)
		oldVal = res.Value
		relInst = inst
	}

	// A committed value that is a template expression is computed when the chart
	// renders; the file holds the expression, not the effective value. Replacing
	// it with a literal through the grid would corrupt the template for every
	// instance, so reject the edit and point the user to file mode (where the
	// expression is explicit). Replacing one template with another is allowed.
	if action == change.ActionSet && model.IsTemplateExpression(oldVal) && !model.IsTemplateExpression(coerced) {
		writeError(w, r, http.StatusUnprocessableEntity, CodeValidationFailed,
			"this value is a template expression, computed when the chart renders; edit it in file mode so the template is preserved")
		return
	}

	// A unit that goes missing off a CPU or memory quantity is a thousand-fold
	// change wearing the clothes of a small one, and only the committed value
	// says which unit the parameter was written in - so this check waits for it.
	if action == change.ActionSet {
		if vr := validate.UnitChange(param, oldVal, coerced); !vr.Valid {
			writeFieldErrors(w, r, "the value is not valid for this parameter", FieldError{Field: "value", Message: vr.Message})
			return
		}
	}

	// Cross-parameter relations (a resource limit must be at least its request,
	// and vice versa) can only be checked now that the instance context is
	// known. The sibling's effective value is read from the committed files.
	if action == change.ActionSet && (param.Validation.AtLeast != "" || param.Validation.AtMost != "") {
		rz := s.resolve(p)
		related := func(id string) (model.Parameter, any, bool) {
			sp, ok := p.ParamByID(id)
			if !ok {
				return model.Parameter{}, nil, false
			}
			return sp, rz.Resolve(sp, relInst).Value, true
		}
		if vr := validate.RelationCheck(param, coerced, related); !vr.Valid {
			writeFieldErrors(w, r, "the value is not valid for this parameter", FieldError{Field: "value", Message: vr.Message})
			return
		}
	}

	defer s.lockDraft(draftOwner(r))()
	draft, err := s.Store.Draft(draftOwner(r), s.branch())
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
	// Setting a cell back to its committed value cancels the pending edit, and
	// cancelling the only one leaves an empty draft with nothing to review.
	s.dropEmptyDraft(draftOwner(r))
	d := s.Store.CurrentDraft(draftOwner(r))
	pending := 0
	changeID := draft.ID
	if d != nil {
		pending, changeID = len(d.Items), d.ID
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "value": coerced, "pending": pending, "changeId": changeID})
}

// stageSetItem validates rawValue for a parameter on one instance and upserts a
// set item into cr, reusing the shared resolver rv for the committed baseline.
// It returns whether an edit was actually staged and a user-facing error string
// ("" on success). Setting a value that already matches the committed one
// cancels the pending edit (staged=false, no error), mirroring the single-cell
// write path.
// `baseline` is the instance whose committed files supply the "before" value. It
// is the same instance in every ordinary case, and differs only for an instance
// that exists just in the draft, where the clone source holds what the value is
// changing from.
func stageSetItem(cr *change.ChangeRequest, param model.Parameter, instanceName string, inst, baseline model.Instance, rawValue any, rv *resolver.Resolver) (staged bool, msg string) {
	if len(param.BindingsOn(model.LayerInstance, inst)) == 0 {
		return false, "this parameter lives only in a shared file; edit it for everyone instead"
	}
	coerced, err := validate.CoerceValue(param, rawValue)
	if err != nil {
		return false, err.Error()
	}
	if vr := validate.Value(param, coerced); !vr.Valid {
		return false, vr.Message
	}
	if vr := validate.UnitChange(param, rv.Resolve(param, baseline).Value, coerced); !vr.Valid {
		return false, vr.Message
	}
	if param.Validation.AtLeast != "" || param.Validation.AtMost != "" {
		related := func(id string) (model.Parameter, any, bool) {
			sp, ok := rv.Param(id)
			if !ok {
				return model.Parameter{}, nil, false
			}
			return sp, rv.Resolve(sp, baseline).Value, true
		}
		if vr := validate.RelationCheck(param, coerced, related); !vr.Valid {
			return false, vr.Message
		}
	}
	old := rv.Resolve(param, baseline).Value
	cr.UpsertItem(change.Item{
		ParamID: param.ID, Instance: instanceName, Action: change.ActionSet,
		Old: old, New: coerced, UpdatedAt: time.Now().UTC(),
	})
	if stringify(old) == stringify(coerced) {
		cr.RemoveItem(param.ID, instanceName)
		return false, ""
	}
	return true, ""
}

// bulkStageValue stages one parameter's edit across many instances in a single
// request and one draft lock: the fan-out a grid exists for ("set this
// everywhere", "copy a column"). Each target carries its own value, so it also
// expresses copying differing values. Per-target failures are reported
// individually; valid targets still stage.
//
// @Summary     Stage a value edit across many instances
// @Description Stage the same parameter's edit on several instances at once. `edits` is a list of `{instance, value}`; `action` defaults to "set" ("reset"/"exclude" drop the override and ignore value). Each value is coerced and validated independently; invalid targets are reported in `results` while valid ones still stage. Nothing touches Git until the draft is submitted.
// @Tags        Editing & change requests
// @Accept      json
// @Produce     json
// @Param       body body object true "paramId, action, edits[]"
// @Success     200 {object} object
// @Failure     400 {object} APIError "Malformed body"
// @Failure     404 {object} APIError "Parameter not found"
// @Security    CookieSession
// @Router      /api/values/bulk [put]
func (s *Server) bulkStageValue(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ParamID string `json:"paramId"`
		Action  string `json:"action"`
		Edits   []struct {
			Instance string `json:"instance"`
			Value    any    `json:"value"`
		} `json:"edits"`
		Author string `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
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
	if action != change.ActionSet && action != change.ActionReset && action != change.ActionExclude {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "unsupported action")
		return
	}

	type result struct {
		Instance string `json:"instance"`
		OK       bool   `json:"ok"`
		Error    string `json:"error,omitempty"`
	}
	results := make([]result, 0, len(req.Edits))
	staged := 0

	defer s.lockDraft(draftOwner(r))()
	draft, err := s.Store.Draft(draftOwner(r), s.branch())
	if err != nil {
		writeErr(w, err)
		return
	}
	rv := s.resolve(p)
	pendingDraft := s.Store.CurrentDraft(draftOwner(r))
	if _, err = s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
		for _, e := range req.Edits {
			inst, ok := p.InstanceByName(e.Instance)
			baseline := inst
			if !ok {
				// Staged-only instance: a legitimate target (see draftInstance).
				var cloneFrom string
				inst, cloneFrom, ok = draftInstance(pendingDraft, p, e.Instance)
				if !ok {
					results = append(results, result{Instance: e.Instance, Error: "instance not found"})
					continue
				}
				baseline, _ = p.InstanceByName(cloneFrom)
			}
			var errMsg string
			didStage := false
			if action == change.ActionSet {
				didStage, errMsg = stageSetItem(cr, param, e.Instance, inst, baseline, e.Value, rv)
			} else if len(param.BindingsOn(model.LayerInstance, inst)) == 0 {
				errMsg = "this parameter has no instance override to drop"
			} else {
				cr.UpsertItem(change.Item{
					ParamID: param.ID, Instance: e.Instance, Action: action,
					Old: rv.Resolve(param, inst).Value, UpdatedAt: time.Now().UTC(),
				})
				didStage = true
			}
			if errMsg != "" {
				results = append(results, result{Instance: e.Instance, Error: errMsg})
				continue
			}
			if didStage {
				staged++
			}
			results = append(results, result{Instance: e.Instance, OK: true})
		}
		return nil
	}); err != nil {
		writeErr(w, err)
		return
	}

	// A bulk set that cancelled every edit it touched leaves nothing staged.
	s.dropEmptyDraft(draftOwner(r))
	d := s.Store.CurrentDraft(draftOwner(r))
	pending, changeID := 0, draft.ID
	if d != nil {
		pending, changeID = len(d.Items), d.ID
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "staged": staged, "results": results, "pending": pending, "changeId": changeID,
	})
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
	defer s.lockDraft(draftOwner(r))()
	draft := s.Store.CurrentDraft(draftOwner(r))
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
	// Undoing the last staged edit leaves nothing to review, so the draft goes
	// with it rather than sitting in Changes as an empty change request.
	s.dropEmptyDraft(draftOwner(r))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
