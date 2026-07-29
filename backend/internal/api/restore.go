package api

// Snapshot restore: bring a scope of configuration back to how it looked at a
// past git snapshot. Restore never rewrites history - it stages the forward
// edits that reproduce the old values into the current draft, which then flows
// through the ordinary review -> approve -> publish lifecycle. "Undo this
// change" is the same operation with the ref set to the change's parent commit.
//
// Three scopes share one call, so the usage model is uniform from the whole
// application down to a single cell:
//   - "parameter": one (parameter, instance) cell, or a global value;
//   - "instance":  every value that belongs to one instance;
//   - "all":       every instance's values plus every shared/global value.

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/resolver"
	"github.com/abhijeet-oxide/configer/backend/internal/validate"
)

// restoreRequest asks to bring a scope back to its values at Ref (a git ref:
// branch, tag or commit sha).
type restoreRequest struct {
	Ref      string `json:"ref"`
	Scope    string `json:"scope"`
	Instance string `json:"instance"`
	ParamID  string `json:"paramId"`
	// Global targets a shared (base-layer) value in parameter scope, when no
	// single instance owns it.
	Global bool   `json:"global"`
	Author string `json:"author"`
}

// restoreTarget is one cell the restore will try to bring back.
type restoreTarget struct {
	param    model.Parameter
	instance string // "" for a global-scope target
	inst     model.Instance
	global   bool
}

// restore stages the edits that return the selected scope to its values at Ref.
//
// @Summary     Restore configuration to a snapshot
// @Description Stage the edits that bring a scope back to how it looked at a git ref into the current draft (nothing touches Git until it is published). `scope` is "all", "instance" (needs `instance`) or "parameter" (needs `paramId`, plus `instance` unless `global`). Only value edits are restored; a parameter with no value at the ref has its instance override dropped. Returns the draft id, how many cells were staged, and any skipped notes.
// @Tags        Editing & change requests
// @Accept      json
// @Produce     json
// @Param       body body object true "ref, scope, instance?, paramId?, global?"
// @Success     200 {object} object
// @Failure     400 {object} APIError "Missing ref or unknown scope"
// @Failure     404 {object} APIError "Unknown ref, instance or parameter"
// @Security    CookieSession
// @Router      /api/restore [post]
func (s *Server) restore(w http.ResponseWriter, r *http.Request) {
	var req restoreRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
		return
	}
	if req.Ref == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "a snapshot to restore from is required")
		return
	}
	if req.Scope == "" {
		req.Scope = "all"
	}
	if req.Scope != "all" && req.Scope != "instance" && req.Scope != "parameter" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "scope must be all, instance or parameter")
		return
	}

	cur, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	pRef, cleanup, err := s.projectAtRef(req.Ref)
	if err != nil {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "cannot read that snapshot: "+err.Error())
		return
	}
	defer cleanup()

	targets, notFound := restoreTargets(cur, req)
	if notFound != "" {
		writeError(w, r, http.StatusNotFound, CodeNotFound, notFound)
		return
	}

	// The working tree reads through the shared cache; the materialized ref is
	// a throwaway checkout with bytes of its own, so it parses for itself
	// (s.resolve declines to cache anything rooted outside the working tree).
	rvCur := s.resolve(cur)
	rvRef := s.resolve(pRef)

	defer s.lockDraft(draftOwner(r))()
	draft, err := s.Store.Draft(draftOwner(r), s.branch())
	if err != nil {
		writeErr(w, err)
		return
	}

	var skipped []string
	applied := 0
	if _, err := s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
		for _, t := range targets {
			staged, msg := stageRestore(cr, t, pRef, rvCur, rvRef)
			if msg != "" {
				skipped = append(skipped, restoreSkipLabel(t)+": "+msg)
				continue
			}
			if staged {
				applied++
			}
		}
		return nil
	}); err != nil {
		writeErr(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"draftId": draft.ID,
		"applied": applied,
		"skipped": skipped,
		"ref":     req.Ref,
		"scope":   req.Scope,
	})
}

// restoreTargets expands a request into the concrete cells it touches, reading
// the CURRENT catalog (only parameters that still exist can be staged). The
// second return is a user-facing "not found" message, empty when all good.
func restoreTargets(cur *project.Project, req restoreRequest) ([]restoreTarget, string) {
	switch req.Scope {
	case "parameter":
		param, ok := cur.ParamByID(req.ParamID)
		if !ok {
			return nil, "parameter not found"
		}
		if req.Global || (req.Instance == "" && param.Scope == model.ScopeGlobal) {
			return []restoreTarget{{param: param, global: true}}, ""
		}
		inst, ok := cur.InstanceByName(req.Instance)
		if !ok {
			return nil, "instance not found"
		}
		return []restoreTarget{{param: param, instance: req.Instance, inst: inst}}, ""

	case "instance":
		inst, ok := cur.InstanceByName(req.Instance)
		if !ok {
			return nil, "instance not found"
		}
		var out []restoreTarget
		for _, p := range cur.Catalog.Parameters {
			if len(p.BindingsOn(model.LayerInstance, inst)) > 0 {
				out = append(out, restoreTarget{param: p, instance: req.Instance, inst: inst})
			}
		}
		return out, ""

	default: // all
		var out []restoreTarget
		for _, p := range cur.Catalog.Parameters {
			if p.Scope == model.ScopeGlobal {
				out = append(out, restoreTarget{param: p, global: true})
				continue
			}
			for _, inst := range cur.Registry.Instances {
				if len(p.BindingsOn(model.LayerInstance, inst)) > 0 {
					out = append(out, restoreTarget{param: p, instance: inst.Name, inst: inst})
				}
			}
		}
		return out, ""
	}
}

// stageRestore stages one target's restore into cr. It returns whether an edit
// was actually staged (false for a no-op, e.g. the value already matches) and a
// user-facing skip reason ("" when nothing went wrong). It reuses stageSetItem
// for instance cells so restored values pass the same coercion and validation as
// a hand edit and the same "setting a cell back to its committed value cancels
// the pending edit" behavior applies.
func stageRestore(cr *change.ChangeRequest, t restoreTarget, pRef *project.Project, rvCur, rvRef *resolver.Resolver) (bool, string) {
	refParam, ok := pRef.ParamByID(t.param.ID)
	if t.global {
		if !ok {
			return false, "" // absent at the snapshot: nothing to restore for a shared value
		}
		refRes := rvRef.Resolve(refParam, model.Instance{})
		if !refRes.Set {
			return false, ""
		}
		return stageGlobalRestore(cr, t.param, refRes.Value, rvCur)
	}

	// Instance cell. If the instance did not exist at the snapshot there is no
	// value to bring back.
	refInst, instOK := pRef.InstanceByName(t.instance)
	if !ok || !instOK {
		return dropOverrideIfAny(cr, t, rvCur)
	}
	refRes := rvRef.Resolve(refParam, refInst)
	if !refRes.Set {
		return dropOverrideIfAny(cr, t, rvCur)
	}
	// A restore reads BOTH sides straight out of the repository, so the two
	// values can be the same setting decoded differently (the YAML boolean
	// true vs the string "true" for a string-typed parameter). Comparing them
	// as the parameter's own type is what makes "restore the fleet" stage the
	// handful of cells that really moved instead of every cell it looked at.
	if sameAsTyped(t.param, rvCur.Resolve(t.param, t.inst).Value, refRes.Value) {
		return false, ""
	}
	staged, msg := stageSetItem(cr, t.param, t.instance, t.inst, t.inst, refRes.Value, rvCur)
	return staged, msg
}

// sameAsTyped reports whether two raw values mean the same thing once both are
// coerced to the parameter's declared type. A value that cannot be coerced is
// compared as it stands, so an unconvertible value never silently counts as
// equal to a valid one.
func sameAsTyped(param model.Parameter, a, b any) bool {
	ca, errA := validate.CoerceValue(param, a)
	cb, errB := validate.CoerceValue(param, b)
	if errA != nil || errB != nil {
		return stringify(a) == stringify(b)
	}
	return stringify(ca) == stringify(cb)
}

// dropOverrideIfAny stages a reset (drop the instance override) when the cell had
// no value at the snapshot but carries an instance-level override now, so
// restoring means removing that override. When there is nothing to drop it is a
// silent no-op.
func dropOverrideIfAny(cr *change.ChangeRequest, t restoreTarget, rvCur *resolver.Resolver) (bool, string) {
	cur := rvCur.Resolve(t.param, t.inst)
	if cur.Layer != model.LayerInstance {
		return false, "" // no instance override to drop
	}
	cr.UpsertItem(change.Item{
		ParamID: t.param.ID, Instance: t.instance, Action: change.ActionReset,
		Old: cur.Value, UpdatedAt: time.Now().UTC(),
	})
	return true, ""
}

// stageGlobalRestore stages a shared (base-layer) value back to refVal.
func stageGlobalRestore(cr *change.ChangeRequest, param model.Parameter, refVal any, rvCur *resolver.Resolver) (bool, string) {
	if len(param.BindingsOn(model.LayerBase, model.Instance{})) == 0 {
		return false, "no shared location to restore into"
	}
	coerced, err := validate.CoerceValue(param, refVal)
	if err != nil {
		return false, err.Error()
	}
	if vr := validate.Value(param, coerced); !vr.Valid {
		return false, vr.Message
	}
	old := rvCur.Resolve(param, model.Instance{}).Value
	if sameAsTyped(param, old, coerced) {
		return false, "" // already at this value
	}
	cr.UpsertItem(change.Item{
		ParamID: param.ID, Scope: "global", Action: change.ActionSet,
		Old: old, New: coerced, UpdatedAt: time.Now().UTC(),
	})
	return true, ""
}

// restoreSkipLabel names a target that could not be restored, for the response.
func restoreSkipLabel(t restoreTarget) string {
	if t.global {
		return t.param.ID
	}
	return t.param.ID + " on " + t.instance
}
