package api

// Naming a change, before it is named for good.
//
// A change request's title is not just a label: it becomes the branch, and the
// branch is what reviewers, CI and everyone's `git branch -a` sees forever. So
// the moment to find out that a name is taken is while the person is typing it,
// not after a submit that half-succeeded.
//
// This endpoint answers two questions the UI asks on every keystroke (debounced):
// is another change already called this, and what branch would this one get?

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/changeset"
)

// ChangeNameCheck is the answer to "can I call it this?".
type ChangeNameCheck struct {
	// Title is the name as it was checked (trimmed).
	Title string `json:"title"`
	// Available says whether the name can be used as it stands. A name taken by
	// a change that is finished (published or rejected) is still available:
	// history is allowed to repeat, only two OPEN changes under one name is a
	// problem, because that is the pair a reviewer cannot tell apart.
	Available bool `json:"available"`
	// Branch is the branch this change would get. It is shown, not guessed at,
	// so the name someone picks is never a surprise afterwards.
	Branch string `json:"branch"`
	// Conflict is the change already using the name, when there is one.
	Conflict *changeset.NameConflict `json:"conflict,omitempty"`
	// Message is the plain sentence to put under the field. Empty when the name
	// is free and unremarkable.
	Message string `json:"message,omitempty"`
}

// checkChangeName reports whether a change request may be called something, and
// what branch it would get.
//
// @Summary     Check a change request name
// @Description Whether a proposed change-request title is free, and the branch it would produce. A name held by a still-open change is refused (`available:false`) because two open changes under one name cannot be told apart in review; a name held by a published or rejected change is allowed, with a note. Intended to be called while the user types, so the name is settled before submit.
// @Tags        Editing & change requests
// @Produce     json
// @Param       title query string true  "Proposed title"
// @Param       id    query int    false "Change request being named (excluded from the conflict search)"
// @Success     200 {object} ChangeNameCheck
// @Failure     400 {object} APIError "Missing title"
// @Router      /api/changes/name-check [get]
func (s *Server) checkChangeName(w http.ResponseWriter, r *http.Request) {
	title := strings.TrimSpace(r.URL.Query().Get("title"))
	if title == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "a name is required")
		return
	}
	id, _ := strconv.Atoi(r.URL.Query().Get("id"))

	out := ChangeNameCheck{Title: title, Available: true}
	// The branch is computed against the change being named when we know it, so
	// the answer accounts for its own existing branch rather than treating it as
	// somebody else's.
	cr, err := s.Store.Get(id)
	if err != nil || cr == nil {
		cr = s.Store.CurrentDraft(draftOwner(r))
	}
	if cr != nil {
		out.Branch = s.Changes.PlannedBranch(r.Context(), cr, title, branchOwner(r))
	}

	if c := s.Changes.FindNameConflict(title, id); c != nil {
		out.Conflict = c
		if c.Open {
			out.Available = false
			out.Message = "Change " + strconv.Itoa(c.ID) + " is already called this and is still open. " +
				"Pick a different name so the two can be told apart."
		} else {
			// Not a refusal. Someone repeating a name months later is usually
			// doing the same job again, and saying so is more useful than
			// standing in their way.
			out.Message = "Change " + strconv.Itoa(c.ID) + " had this name and is already " + string(c.State) +
				". You can reuse it; the new one gets its own branch."
		}
	}
	writeJSON(w, http.StatusOK, out)
}
