package api

// One cheap question, asked often: "has anything I am looking at moved?"
//
// A workspace with several people in it has to notice a colleague's push, their
// merge, and the change request they just opened. The obvious way to do that is
// to re-poll the things on screen - and that is what the app grew into: the
// grid, the draft, the change list, the findings, the repository status and the
// file list each on their own timer, each re-fetching in full whether or not
// anything had happened. The grid is the most expensive read the service serves
// (it resolves every parameter on every instance out of the repository's real
// files), so polling it on a timer is precisely the wrong thing to poll.
//
// So nothing on screen polls. ONE small endpoint answers "what revision is the
// world at", the client asks only that, and it re-reads the expensive things
// only when the answer actually changes. A quiet workspace costs one tiny
// response per interval no matter how many views are open; a busy one refreshes
// everything exactly once per real event.
//
// Two numbers, because there are two sources of truth and they move
// independently:
//
//   head    the repository's own HEAD. Moves on a publish, a sync that
//           fast-forwards, a catalog write - anything that changed the FILES.
//   changes the change-request store's state. Moves when a draft is staged,
//           submitted, approved, rejected or resumed - none of which touch the
//           trunk, and all of which the screen has to notice.

import (
	"net/http"
	"strconv"
	"strings"
)

// storeRev is a cheap, monotonic-enough summary of the change-request store:
// how many change requests there are and when the newest of them was last
// touched. Together they move on every mutation - an edit bumps the timestamp,
// a discarded draft drops the count - without the store having to keep a
// version counter that both implementations would have to agree on.
//
// It is deliberately a STRING and deliberately opaque: the client's only
// question is "is this the same as last time", and giving it anything it could
// be tempted to parse would be inventing a contract nobody needs.
func (s *Server) storeRev() string {
	list := s.Store.List()
	newest := ""
	for _, cr := range list {
		if t := cr.UpdatedAt.UTC().Format("20060102150405.000"); t > newest {
			newest = t
		}
	}
	return strconv.Itoa(len(list)) + "-" + newest
}

// revision answers what revision the repository and the change store are at.
//
// @Summary     Current revision
// @Description A tiny answer to "has anything moved?": the repository's `head` (files, catalog, publishes) and an opaque `changes` token for the change-request store (drafts, submissions, approvals, rejections). Clients poll THIS instead of re-reading the grid, the draft and the change list on their own timers, and refresh those only when one of these two values differs from the last answer. Cheap enough to poll often; carries no data of its own on purpose.
// @Tags        Reads
// @Produce     json
// @Success     200 {object} map[string]string
// @Router      /api/revision [get]
func (s *Server) revision(w http.ResponseWriter, _ *http.Request) {
	// No cache, ever: a cached answer to "has anything changed" says no
	// forever, which is the one failure this endpoint cannot have.
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{
		"head":    s.catalogRev(),
		"changes": s.storeRev(),
		"branch":  strings.TrimSpace(s.branch()),
	})
}
