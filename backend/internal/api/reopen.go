package api

// Resuming a rejected change.
//
// A rejection is not the end of a piece of work - it is a request for another
// pass at it. Everything needed for that pass is already recorded: the change
// request keeps its items, and (since Reject stopped deleting it) its branch
// still stands. What was missing was the way back in. The author returned to a
// parameter grid showing the original value, with nothing anywhere saying an
// attempt had been made, and retyped every edit from memory.
//
// Reopen puts the rejected change's items back into the author's draft so they
// can be fixed and sent again. Two things make it a resumption rather than a
// replay:
//
//   - Every item is RE-BASELINED against the repository as it stands now. A
//     change can sit rejected for a week while the trunk moves; an item still
//     carrying its original "old" value would show the reviewer a before-value
//     that is no longer true.
//   - An item the world has since SETTLED - somebody else already set that
//     value, the parameter is already managed, the file already reads that way
//     - is dropped rather than carried. Resubmitting a change whose edits are
//     all no-ops is the one outcome nobody wants from pressing Resume.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/resolver"
)

// settled reports whether an item asks for something the repository already
// has, and therefore has nothing left to change. Only the cases that can be
// judged cheaply and certainly are answered; anything else is carried across,
// because dropping an edit somebody meant is worse than carrying a no-op.
func settled(p *project.Project, rv *resolver.Resolver, it change.Item) bool {
	switch it.Act() {
	case change.ActionSet:
		param, ok := p.ParamByID(it.ParamID)
		if !ok {
			return false
		}
		inst := model.Instance{}
		if it.Scope != "global" && it.Instance != "" {
			inst, ok = p.InstanceByName(it.Instance)
			if !ok {
				// The instance is gone, or this change was going to create it.
				// Either way its cell cannot be read, so nothing is settled.
				return false
			}
		}
		return stringify(rv.Resolve(param, inst).Value) == stringify(it.New)
	case change.ActionAddParameter:
		_, exists := p.ParamByID(it.ParamID)
		return exists
	case change.ActionUnmanageParameter:
		_, exists := p.ParamByID(it.ParamID)
		return !exists
	case change.ActionEditFile:
		content, ok := it.New.(string)
		if !ok || it.File == "" {
			return false
		}
		b, err := os.ReadFile(filepath.Join(p.Root, filepath.Clean(it.File)))
		return err == nil && string(b) == content
	}
	return false
}

// rebaseline replaces an item's Old with the value the repository holds NOW, so
// the resumed change describes the edit it is actually making rather than the
// one it was making when it was refused.
func rebaseline(p *project.Project, rv *resolver.Resolver, it change.Item) change.Item {
	if it.Act() != change.ActionSet {
		return it
	}
	param, ok := p.ParamByID(it.ParamID)
	if !ok {
		return it
	}
	inst := model.Instance{}
	if it.Scope != "global" && it.Instance != "" {
		if inst, ok = p.InstanceByName(it.Instance); !ok {
			return it
		}
	}
	it.Old = rv.Resolve(param, inst).Value
	return it
}

// reopenChange copies a rejected change request's work into the caller's draft.
//
// @Summary     Resume a rejected change
// @Description Copies a REJECTED change request's edits into the caller's draft so they can be corrected and submitted again. Items the repository has since settled (the value is already what the change asked for) are dropped and reported as `settled`; the rest are re-baselined against the current files. When the caller has no draft yet, the change's title, description, category and reference are carried over too, and the new draft records `resumedFrom`.
// @Tags        Editing & change requests
// @Accept      json
// @Produce     json
// @Param       id path int true "Change request id"
// @Success     200 {object} object
// @Failure     400 {object} APIError "Invalid id"
// @Failure     404 {object} APIError "No such change request"
// @Failure     409 {object} APIError "Only a rejected change can be resumed"
// @Failure     422 {object} APIError "Nothing left to resume"
// @Security    CookieSession
// @Router      /api/changes/{id}/reopen [post]
func (s *Server) reopenChange(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid id")
		return
	}
	var req struct {
		Author string `json:"author"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	source, err := s.Store.Get(id)
	if err != nil {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "no such change request")
		return
	}
	if source.State != change.StateRejected {
		writeError(w, r, http.StatusConflict, CodeConflict,
			"only a rejected change can be resumed; this one is "+string(source.State))
		return
	}

	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	rv := s.resolve(p)

	carry := make([]change.Item, 0, len(source.Items))
	settledCount := 0
	for _, it := range source.Items {
		if settled(p, rv, it) {
			settledCount++
			continue
		}
		it = rebaseline(p, rv, it)
		it.UpdatedAt = time.Now().UTC()
		carry = append(carry, it)
	}
	if len(carry) == 0 {
		writeError(w, r, http.StatusUnprocessableEntity, CodeValidationFailed,
			"there is nothing left to resume: every edit in this change is already how the repository reads today")
		return
	}

	owner := author(r, req.Author)
	defer s.lockDraft(owner)()
	// Whether the draft is BRAND NEW decides whether the change's own words
	// come with it. Overwriting the title of work somebody is already part-way
	// through would rename their change out from under them.
	fresh := s.Store.CurrentDraft(owner) == nil
	draft, err := s.Store.Draft(owner, s.branch())
	if err != nil {
		writeErr(w, err)
		return
	}
	updated, err := s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
		for _, it := range carry {
			cr.UpsertItem(it)
		}
		if fresh {
			cr.Title, cr.Description = source.Title, source.Description
			cr.Category, cr.Reference = source.Category, source.Reference
			cr.ResumedFrom = source.ID
		}
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"changeId": updated.ID,
		"draft":    updated,
		"carried":  len(carry),
		"settled":  settledCount,
		"from":     source.Label(),
	})
}
