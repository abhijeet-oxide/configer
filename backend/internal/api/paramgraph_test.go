package api

import (
	"net/http"
	"testing"
)

// paramLife is the shape /api/parameters/{id}/history now answers with: the
// trunk, and the change requests that touched this parameter in any state.
type paramLife struct {
	Entries []struct {
		SHA          string `json:"sha"`
		Value        string `json:"value"`
		Changed      bool   `json:"changed"`
		ChangeID     int    `json:"changeId"`
		ChangeNumber int    `json:"changeNumber"`
		ChangeTitle  string `json:"changeTitle"`
	} `json:"entries"`
	Changes []struct {
		ID           int    `json:"id"`
		Number       int    `json:"number"`
		Title        string `json:"title"`
		State        string `json:"state"`
		Author       string `json:"author"`
		Branch       string `json:"branch"`
		BaseSHA      string `json:"baseSha"`
		CommitSHA    string `json:"commitSha"`
		MergeSHA     string `json:"mergeSha"`
		RejectedBy   string `json:"rejectedBy"`
		RejectReason string `json:"rejectReason"`
		ResumedFrom  int    `json:"resumedFrom"`
		ResumedInto  int    `json:"resumedInto"`
		Edits        []struct {
			Instance string `json:"instance"`
			Action   string `json:"action"`
			Old      string `json:"old"`
			New      string `json:"new"`
		} `json:"edits"`
	} `json:"changes"`
}

func (l paramLife) change(t *testing.T, id int) int {
	t.Helper()
	for i, c := range l.Changes {
		if c.ID == id {
			return i
		}
	}
	t.Fatalf("change %d is absent from the parameter's history: %+v", id, l.Changes)
	return -1
}

// TestParameterLifeCarriesRejectedAndResumedWork is the git-blame question:
// standing on a value, can the reader see every proposal that touched it -
// including the one that was refused, which reaches no commit and therefore
// appears in no log - and follow the same work through to what was published?
func TestParameterLifeCarriesRejectedAndResumedWork(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	// Proposed, and turned down.
	rejectedID := stageAndSubmit(t, h, 9090, "raise the port")
	doJSON(t, h, http.MethodPost, "/api/changes/"+itoa(rejectedID)+"/reject",
		map[string]any{"reason": "needs a ticket", "author": "bob"}, nil)

	var life paramLife
	doJSON(t, h, http.MethodGet, "/api/parameters/p1/history?instance=staging", nil, &life)

	rj := life.Changes[life.change(t, rejectedID)]
	if rj.State != "rejected" || rj.RejectedBy != "bob" || rj.RejectReason != "needs a ticket" {
		t.Fatalf("rejected episode wrong: %+v", rj)
	}
	if rj.Number != 1 || rj.Author != "alice" || rj.Branch == "" || rj.BaseSHA == "" || rj.CommitSHA == "" {
		t.Fatalf("a rejected episode must still say which CR, whose, and where it forked: %+v", rj)
	}
	if len(rj.Edits) != 1 || rj.Edits[0].Old != "8080" || rj.Edits[0].New != "9090" {
		t.Fatalf("rejected edits wrong: %+v", rj.Edits)
	}
	// It reached no commit, so nothing on the trunk may claim to be it.
	for _, e := range life.Entries {
		if e.ChangeID == rejectedID {
			t.Fatalf("a rejected change must not be attributed a trunk commit: %+v", e)
		}
	}

	// Resumed, and this time published.
	var resumed struct {
		Draft struct {
			ID int `json:"id"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodPost, "/api/changes/"+itoa(rejectedID)+"/reopen",
		map[string]any{"author": "alice"}, &resumed)
	secondID := resumed.Draft.ID
	doRaw(t, h, http.MethodPost, "/api/changes/"+itoa(secondID)+"/submit",
		map[string]any{"title": "raise the port, with a ticket", "author": "alice"})
	doJSON(t, h, http.MethodPost, "/api/changes/"+itoa(secondID)+"/approve", map[string]any{"author": "bob"}, nil)
	doRaw(t, h, http.MethodPost, "/api/changes/"+itoa(secondID)+"/merge", map[string]any{"author": "bob"})

	doJSON(t, h, http.MethodGet, "/api/parameters/p1/history?instance=staging", nil, &life)

	rj = life.Changes[life.change(t, rejectedID)]
	second := life.Changes[life.change(t, secondID)]
	// The two attempts are one piece of work, and each end knows the other.
	if second.ResumedFrom != rejectedID || rj.ResumedInto != secondID {
		t.Fatalf("lineage broken: rejected.resumedInto=%d second.resumedFrom=%d",
			rj.ResumedInto, second.ResumedFrom)
	}
	if second.State != "published" {
		t.Fatalf("second attempt state = %q, want published", second.State)
	}
	// And the commit that carries the new value names the review it came out of,
	// which is the whole point of reading history from a parameter.
	found := false
	for _, e := range life.Entries {
		if e.ChangeID == secondID {
			found = true
			if e.ChangeNumber != second.Number || e.ChangeTitle != second.Title {
				t.Fatalf("trunk commit names the change wrongly: %+v", e)
			}
		}
	}
	if !found {
		t.Fatalf("no trunk commit is attributed to the published change: %+v", life.Entries)
	}
}

// TestParameterLifeIgnoresOtherCells: an edit to a different parameter, or to
// another instance's cell, is not part of this cell's story.
func TestParameterLifeIgnoresOtherCells(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()
	id := stageAndSubmit(t, h, 9090, "raise the port")

	var life paramLife
	doJSON(t, h, http.MethodGet, "/api/parameters/p1/history?instance=other", nil, &life)
	for _, c := range life.Changes {
		if c.ID == id {
			t.Fatalf("a staging-only edit turned up in another instance's history: %+v", c)
		}
	}
	doJSON(t, h, http.MethodGet, "/api/parameters/nope/history", nil, &life)
	if len(life.Changes) != 0 {
		t.Fatalf("an unrelated parameter has episodes: %+v", life.Changes)
	}
}

// TestParameterLifeWithoutAnInstanceCoversThemAll: a parameter opened from its
// ROW rather than a cell names no instance, and that is how people open it.
// Filtering instance-scoped edits out there meant a value somebody had just
// changed showed a history with no change requests in it at all - the screen
// saying nothing had happened, moments after something had.
func TestParameterLifeWithoutAnInstanceCoversThemAll(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()
	id := stageAndSubmit(t, h, 9090, "raise the port")

	var life paramLife
	doJSON(t, h, http.MethodGet, "/api/parameters/p1/history", nil, &life)
	i := life.change(t, id)
	if got := life.Changes[i].Edits[0].Instance; got != "staging" {
		t.Fatalf("edit instance = %q, want the cell it applies to named", got)
	}

	// Naming the instance still narrows: another instance's story is not this
	// one's, and that is the whole reason the filter exists.
	doJSON(t, h, http.MethodGet, "/api/parameters/p1/history?instance=elsewhere", nil, &life)
	for _, c := range life.Changes {
		if c.ID == id {
			t.Fatalf("a staging edit leaked into another instance's history: %+v", c)
		}
	}
}
