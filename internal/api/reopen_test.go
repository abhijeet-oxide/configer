package api

import (
	"context"
	"net/http"
	"testing"
)

// stageAndSubmit stages one value edit and sends it for review, returning the
// change request's store id.
func stageAndSubmit(t *testing.T, h http.Handler, value any, title string) int {
	t.Helper()
	doJSON(t, h, http.MethodPut, "/api/values", map[string]any{
		"paramId": "p1", "instance": "staging", "value": value, "author": "alice",
	}, nil)
	var draft struct {
		Draft struct {
			ID int `json:"id"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)
	if draft.Draft.ID == 0 {
		t.Fatal("no draft after staging an edit")
	}
	rec := doRaw(t, h, http.MethodPost, "/api/changes/"+itoa(draft.Draft.ID)+"/submit",
		map[string]any{"title": title, "author": "alice"})
	if rec.Code != http.StatusOK && rec.Code != http.StatusAccepted {
		t.Fatalf("submit: want 200/202, got %d (%s)", rec.Code, rec.Body.String())
	}
	return draft.Draft.ID
}

// TestRejectKeepsTheWork is the whole point of the rejection changes: a
// refused change must still be readable, resumable and attributable
// afterwards. Rejection used to delete the branch and record only a comment,
// which left the author with a grid showing the original value and no way back
// to what they had proposed.
func TestRejectKeepsTheWork(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	id := stageAndSubmit(t, h, 9090, "raise the port")

	var rejected struct {
		State        string `json:"state"`
		Branch       string `json:"branch"`
		RejectedBy   string `json:"rejectedBy"`
		RejectReason string `json:"rejectReason"`
		Items        []struct {
			New any `json:"new"`
		} `json:"items"`
	}
	doJSON(t, h, http.MethodPost, "/api/changes/"+itoa(id)+"/reject",
		map[string]any{"reason": "needs a ticket", "author": "bob"}, &rejected)

	if rejected.State != "rejected" {
		t.Fatalf("state after reject = %q, want rejected", rejected.State)
	}
	// The refusal is a FACT on the change, not a sentence somebody has to find
	// in the discussion.
	if rejected.RejectedBy != "bob" || rejected.RejectReason != "needs a ticket" {
		t.Fatalf("refusal not recorded: by=%q reason=%q", rejected.RejectedBy, rejected.RejectReason)
	}
	// The items survive - they are the work somebody was asked to fix.
	if len(rejected.Items) != 1 {
		t.Fatalf("rejected change lost its items: %+v", rejected.Items)
	}
	// And so does the branch: a rejected change's branch holds the only copy
	// of that work, unlike a published one whose branch holds nothing new.
	if rejected.Branch == "" {
		t.Fatal("rejected change has no branch recorded")
	}
	if !s.Backend.BranchExists(context.Background(), rejected.Branch) {
		t.Fatalf("branch %q was deleted on reject; a rejected change's work must survive", rejected.Branch)
	}

	// The published grid is unchanged: nothing was merged, so the parameter
	// still reads what the trunk says.
	var g gridResponse
	doJSON(t, h, http.MethodGet, "/api/grid", nil, &g)
	if got := gridCell(t, g, "p1", "staging"); got != float64(8080) {
		t.Fatalf("published value after a rejection = %v, want the original 8080", got)
	}
}

// TestReopenResumesRejectedWork covers the way back in: a rejected change's
// edits return to the author's draft, re-baselined, and can be sent again.
func TestReopenResumesRejectedWork(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	id := stageAndSubmit(t, h, 9090, "raise the port")
	doJSON(t, h, http.MethodPost, "/api/changes/"+itoa(id)+"/reject",
		map[string]any{"reason": "needs a ticket", "author": "bob"}, nil)

	var resumed struct {
		Carried int `json:"carried"`
		Settled int `json:"settled"`
		Draft   struct {
			ID          int    `json:"id"`
			Title       string `json:"title"`
			ResumedFrom int    `json:"resumedFrom"`
			Items       []struct {
				ParamID string `json:"paramId"`
				Old     any    `json:"old"`
				New     any    `json:"new"`
			} `json:"items"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodPost, "/api/changes/"+itoa(id)+"/reopen",
		map[string]any{"author": "alice"}, &resumed)

	if resumed.Carried != 1 || resumed.Settled != 0 {
		t.Fatalf("carried=%d settled=%d, want 1 and 0", resumed.Carried, resumed.Settled)
	}
	if resumed.Draft.ID == id {
		t.Fatal("resuming must open a NEW draft, not reopen the rejected change itself")
	}
	// A fresh draft inherits the change's own words, so the second attempt
	// reads as the same piece of work rather than an unexplained edit.
	if resumed.Draft.Title != "raise the port" || resumed.Draft.ResumedFrom != id {
		t.Fatalf("lineage lost: title=%q resumedFrom=%d", resumed.Draft.Title, resumed.Draft.ResumedFrom)
	}
	if len(resumed.Draft.Items) != 1 || resumed.Draft.Items[0].New != float64(9090) {
		t.Fatalf("resumed items wrong: %+v", resumed.Draft.Items)
	}
	// Re-baselined against the repository as it stands NOW, not as it stood
	// when the change was refused.
	if resumed.Draft.Items[0].Old != float64(8080) {
		t.Fatalf("old value = %v, want the current committed 8080", resumed.Draft.Items[0].Old)
	}

}

// TestReopenRefusesWorkTheWorldHasSettled: while a change sat rejected somebody
// else made the same edit and it was published. Pressing Resume then has
// nothing to do, and must say so rather than staging a change of no-ops.
func TestReopenRefusesWorkTheWorldHasSettled(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	rejectedID := stageAndSubmit(t, h, 9090, "raise the port")
	doJSON(t, h, http.MethodPost, "/api/changes/"+itoa(rejectedID)+"/reject",
		map[string]any{"author": "bob"}, nil)

	// A colleague proposes the very same value, and theirs is published.
	otherID := stageAndSubmit(t, h, 9090, "raise the port again")
	doJSON(t, h, http.MethodPost, "/api/changes/"+itoa(otherID)+"/approve", map[string]any{"author": "bob"}, nil)
	rec := doRaw(t, h, http.MethodPost, "/api/changes/"+itoa(otherID)+"/merge", map[string]any{"author": "bob"})
	if rec.Code != http.StatusOK && rec.Code != http.StatusAccepted {
		t.Fatalf("merge: want 200/202, got %d (%s)", rec.Code, rec.Body.String())
	}

	rec = doRaw(t, h, http.MethodPost, "/api/changes/"+itoa(rejectedID)+"/reopen", map[string]any{"author": "alice"})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("resuming settled work: want 422, got %d (%s)", rec.Code, rec.Body.String())
	}
}

// TestReopenRefusesWhatIsNotRejected: an open change is already open, and a
// published one is reverted rather than resumed.
func TestReopenRefusesWhatIsNotRejected(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()
	id := stageAndSubmit(t, h, 9090, "raise the port")

	rec := doRaw(t, h, http.MethodPost, "/api/changes/"+itoa(id)+"/reopen", map[string]any{"author": "alice"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("resuming an open change: want 409, got %d (%s)", rec.Code, rec.Body.String())
	}
	rec = doRaw(t, h, http.MethodPost, "/api/changes/999999/reopen", map[string]any{"author": "alice"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("resuming an unknown change: want 404, got %d", rec.Code)
	}
}

// TestGridViewsARejectedChange: the parameters page can be read through a
// named change request, which is the only way a rejected proposal's values can
// be seen at all - they reach no commit and no branch the trunk knows about.
func TestGridViewsARejectedChange(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()
	id := stageAndSubmit(t, h, 9090, "raise the port")
	doJSON(t, h, http.MethodPost, "/api/changes/"+itoa(id)+"/reject", map[string]any{"author": "bob"}, nil)

	var g gridResponse
	doJSON(t, h, http.MethodGet, "/api/grid?change="+itoa(id), nil, &g)
	if got := gridCell(t, g, "p1", "staging"); got != float64(9090) {
		t.Fatalf("value through the rejected change = %v, want the 9090 it proposed", got)
	}
	if g.Viewing == nil {
		t.Fatal("a change-scoped grid read must name the change it is showing")
	}
	if g.Viewing.ID != id || !g.Viewing.ReadOnly || string(g.Viewing.State) != "rejected" {
		t.Fatalf("viewing = %+v, want the rejected change, read-only", g.Viewing)
	}

	// The default read is unaffected: main still says what main says.
	var plain gridResponse
	doJSON(t, h, http.MethodGet, "/api/grid", nil, &plain)
	if got := gridCell(t, plain, "p1", "staging"); got != float64(8080) {
		t.Fatalf("default grid = %v, want the published 8080", got)
	}
	if plain.Viewing != nil {
		t.Fatalf("a plain grid read must not claim to be viewing a change: %+v", plain.Viewing)
	}

	if rec := doRaw(t, h, http.MethodGet, "/api/grid?change=nope", nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("non-numeric change: want 400, got %d", rec.Code)
	}
	if rec := doRaw(t, h, http.MethodGet, "/api/grid?change=999999", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown change: want 404, got %d", rec.Code)
	}
}

// gridCell reads one cell's value out of a grid response.
func gridCell(t *testing.T, g gridResponse, paramID, instance string) any {
	t.Helper()
	for _, row := range g.Rows {
		if row.Param.ID != paramID {
			continue
		}
		cell, ok := row.Cells[instance]
		if !ok {
			t.Fatalf("no cell for instance %q", instance)
		}
		return cell.Value
	}
	t.Fatalf("no row for parameter %q", paramID)
	return nil
}

// TestRevisionMovesWithTheWorld covers the heartbeat every screen now depends
// on (see frontend pulse.ts): if it fails to move when something changes, the
// UI silently shows a stale repository - which is worse than not polling at
// all, because it looks current.
func TestRevisionMovesWithTheWorld(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	read := func() (string, string) {
		t.Helper()
		var r struct {
			Head    string `json:"head"`
			Changes string `json:"changes"`
		}
		doJSON(t, h, http.MethodGet, "/api/revision", nil, &r)
		return r.Head, r.Changes
	}

	head0, changes0 := read()
	if head0 == "" || changes0 == "" {
		t.Fatalf("revision must always answer: head=%q changes=%q", head0, changes0)
	}
	// Asking twice without touching anything must give the same answer, or the
	// client refreshes everything on every beat.
	if h1, c1 := read(); h1 != head0 || c1 != changes0 {
		t.Fatalf("revision moved while nothing happened: %q/%q then %q/%q", head0, changes0, h1, c1)
	}

	// Staging an edit changes no file, so only the change-store half moves.
	doJSON(t, h, http.MethodPut, "/api/values", map[string]any{
		"paramId": "p1", "instance": "staging", "value": 9090, "author": "alice",
	}, nil)
	head1, changes1 := read()
	if changes1 == changes0 {
		t.Fatal("staging an edit did not move the change-store revision")
	}
	if head1 != head0 {
		t.Fatal("staging an edit must not move the repository revision: nothing was committed")
	}

	// Publishing does move the repository half.
	var draft struct {
		Draft struct {
			ID int `json:"id"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)
	doRaw(t, h, http.MethodPost, "/api/changes/"+itoa(draft.Draft.ID)+"/submit",
		map[string]any{"title": "raise the port", "author": "alice"})
	doJSON(t, h, http.MethodPost, "/api/changes/"+itoa(draft.Draft.ID)+"/approve", map[string]any{"author": "bob"}, nil)
	doRaw(t, h, http.MethodPost, "/api/changes/"+itoa(draft.Draft.ID)+"/merge", map[string]any{"author": "bob"})
	if head2, _ := read(); head2 == head1 {
		t.Fatal("publishing a change did not move the repository revision")
	}
}
