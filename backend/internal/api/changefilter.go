package api

// Finding one change among thousands.
//
// A change request is never deleted. Published ones stay, rejected ones stay
// (deliberately - a rejected change holds the only copy of work somebody was
// asked to fix), and an application that has been in service for a year has
// thousands. The list endpoint pages, which stops the service streaming all of
// them, and does nothing whatsoever for the person looking for CR-412: the
// first page is simply the newest fifty, and everything they might want is
// behind a cursor they have no reason to think to follow.
//
// So the list can be NARROWED before it is paged, two ways, and they answer the
// two questions people actually arrive with:
//
//   state  "what is in flight?" - the handful being worked on right now.
//          Always a small set however old the application is, which is what
//          lets a picker show it COMPLETE rather than truncated.
//   q      "where is the one about the media namespace?" - a search across
//          everything, so reaching an old change does not mean paging through
//          the years in front of it.
//
// Both are applied BEFORE paging, so `hasMore` and the cursor describe the
// filtered list rather than the whole store - a page that says there is no more
// when there is, or the reverse, is worse than no paging at all.

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
)

// openStates are the states a change is still ALIVE in: somebody is writing it,
// or somebody is being waited on. Published and rejected are endings.
var openStates = map[change.State]bool{
	change.StateDraft:       true,
	change.StateUnderReview: true,
	change.StateApproved:    true,
}

// changeFilter is a parsed `?state=` + `?q=`.
type changeFilter struct {
	states map[change.State]bool // nil means every state
	q      string                // lowercased; "" means no search
}

// parseChangeFilter reads the narrowing parameters off a request.
//
// `state` takes a comma-separated list of states, plus two words that are how
// people actually think about it: `open` (being worked on or waited on) and
// `closed` (published or rejected). An unrecognised state is ignored rather
// than refused - a filter nobody can spell is not worth a 400, and dropping it
// leaves the caller with more results, never fewer than they asked for.
func parseChangeFilter(r *http.Request) changeFilter {
	f := changeFilter{q: strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))}
	raw := strings.TrimSpace(r.URL.Query().Get("state"))
	if raw == "" {
		return f
	}
	states := map[change.State]bool{}
	for _, part := range strings.Split(raw, ",") {
		switch s := change.State(strings.ToLower(strings.TrimSpace(part))); s {
		case "":
		case "open":
			for st := range openStates {
				states[st] = true
			}
		case "closed":
			states[change.StatePublished] = true
			states[change.StateRejected] = true
		case change.StateDraft, change.StateUnderReview, change.StateApproved,
			change.StatePublished, change.StateRejected:
			states[s] = true
		}
	}
	if len(states) > 0 {
		f.states = states
	}
	return f
}

// active reports whether this filter narrows anything at all.
func (f changeFilter) active() bool { return f.states != nil || f.q != "" }

// match reports whether one change request survives the filter.
//
// The search deliberately covers the handles people REACH FOR: the number they
// were given in a meeting ("412", or "CR-412" as they would write it), the
// words in the title, whose it is, the ticket it was raised under, and the
// branch when somebody is coming from a git client. Not the item values - a
// search box in a change picker that matched on configuration values would
// return every change that ever touched port 8080, which is not what anybody
// typing in a change picker means.
func (f changeFilter) match(cr *change.ChangeRequest) bool {
	if f.states != nil && !f.states[cr.State] {
		return false
	}
	if f.q == "" {
		return true
	}
	// A number matches the CR number exactly, so typing 41 does not bury CR-41
	// under CR-412, CR-410 and everything else containing those digits.
	if n, err := strconv.Atoi(strings.TrimPrefix(f.q, "cr-")); err == nil {
		if cr.Number == n {
			return true
		}
	}
	for _, field := range []string{cr.Title, cr.Author, cr.Reference, cr.Branch, cr.Category} {
		if field != "" && strings.Contains(strings.ToLower(field), f.q) {
			return true
		}
	}
	return false
}

// filterChanges applies the filter, preserving the store's newest-first order.
// The result shares the store's pointers - like everything else the store hands
// out, they are copies already (see crstore), so there is nothing here to
// alias into.
func filterChanges(all []*change.ChangeRequest, f changeFilter) []*change.ChangeRequest {
	if !f.active() {
		return all
	}
	out := make([]*change.ChangeRequest, 0, len(all))
	for _, cr := range all {
		if f.match(cr) {
			out = append(out, cr)
		}
	}
	return out
}
