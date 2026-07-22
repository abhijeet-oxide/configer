package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
)

// revertChange stages the inverse of an existing change request's edits into
// the current draft, so publishing that draft rolls the change back. This is
// the one-click rollback path for "an instance was updated and now has an
// issue": the revert still flows through review -> approve -> publish, leaving a
// full Git trail rather than a silent force-push.
//
// Value, file and instance-metadata edits invert by swapping old and new; a
// scaffolded instance inverts to a retire. Retiring an instance cannot be
// reversed here (its folder and files are gone), so those items are reported as
// skipped instead of guessed at.
//
// @Summary     Revert a change request
// @Description Stage the inverse of a change request's edits into the current draft so publishing it rolls the change back. Value, file and add-instance edits invert; retiring an instance is skipped (its files are gone). Returns the draft id, how many items were staged, and any skipped items.
// @Tags        Editing & change requests
// @Produce     json
// @Param       id path int true "Change request id to revert"
// @Success     200 {object} object
// @Failure     400 {object} APIError "Invalid id or nothing to revert"
// @Failure     404 {object} APIError "Unknown change request"
// @Security    CookieSession
// @Router      /api/changes/{id}/revert [post]
func (s *Server) revertChange(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid id")
		return
	}
	src, err := s.Store.Get(id)
	if err != nil {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "change request not found")
		return
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	draft, err := s.Store.Draft(author(r, ""), s.branch())
	if err != nil {
		writeErr(w, err)
		return
	}

	var skipped []string
	applied := 0
	if _, err := s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
		for _, it := range src.Items {
			inv, ok := inverseItem(it)
			if !ok {
				skipped = append(skipped, revertLabel(it))
				continue
			}
			inv.UpdatedAt = time.Now().UTC()
			cr.UpsertItem(inv)
			applied++
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
		"source":  id,
	})
}

// inverseItem builds the edit that undoes it. Returns false when the change
// cannot be safely reversed from the model alone.
func inverseItem(it change.Item) (change.Item, bool) {
	switch it.Act() {
	case change.ActionSet, change.ActionEditFile:
		// A value or file edit reverses by swapping old and new.
		if stringify(it.Old) == stringify(it.New) {
			return change.Item{}, false
		}
		inv := it
		inv.Old, inv.New = it.New, it.Old
		return inv, true
	case change.ActionUpdateInstance:
		// Only reversible if the prior metadata was captured.
		if it.Old == nil {
			return change.Item{}, false
		}
		inv := it
		inv.Old, inv.New = it.New, it.Old
		return inv, true
	case change.ActionReset, change.ActionExclude:
		// The item removed or tombstoned an override; restoring it writes the
		// prior value back. With no prior value there is nothing to restore.
		if it.Old == nil || it.Old == "" {
			return change.Item{}, false
		}
		return change.Item{ParamID: it.ParamID, Instance: it.Instance, Scope: it.Scope,
			Action: change.ActionSet, Old: it.New, New: it.Old}, true
	case change.ActionAddInstance:
		// Undo a scaffolded instance by retiring it.
		return change.Item{Instance: it.Instance, Action: change.ActionRemoveInstance, Old: it.New}, true
	default:
		// remove-instance: the folder and files are gone; cannot reconstruct.
		return change.Item{}, false
	}
}

// revertLabel names an item that could not be reverted, for the response.
func revertLabel(it change.Item) string {
	if it.Instance != "" {
		return string(it.Act()) + " " + it.Instance
	}
	return string(it.Act()) + " " + it.ParamID
}
