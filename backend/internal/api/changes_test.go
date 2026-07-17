package api

import (
	"net/http"
	"testing"
)

// TestChangeCommentsAndReviewers exercises the review-workspace additions:
// comments append to a change request and persist, reviewer assignment
// replaces the list (trimmed, deduplicated), and an empty comment is refused.
func TestChangeCommentsAndReviewers(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	// Stage one edit so a draft CR exists to comment on.
	doJSON(t, h, http.MethodPut, "/api/values", map[string]any{
		"paramId": "p1", "instance": "staging", "value": 9090, "author": "alice",
	}, nil)
	var draft struct {
		Draft struct {
			ID int `json:"id"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)
	id := draft.Draft.ID
	if id == 0 {
		t.Fatal("no draft change request after staging an edit")
	}
	crPath := "/api/changes/" + itoa(id)

	// A comment appends with an id, author and timestamp.
	var cr struct {
		Comments []struct {
			ID     int    `json:"id"`
			Author string `json:"author"`
			Body   string `json:"body"`
		} `json:"comments"`
		Reviewers []string `json:"reviewers"`
	}
	doJSON(t, h, http.MethodPost, crPath+"/comments", map[string]any{
		"body": "please double-check the port", "author": "bob",
	}, &cr)
	if len(cr.Comments) != 1 || cr.Comments[0].Body != "please double-check the port" || cr.Comments[0].Author != "bob" {
		t.Fatalf("unexpected comments after post: %+v", cr.Comments)
	}
	doJSON(t, h, http.MethodPost, crPath+"/comments", map[string]any{"body": "second note"}, &cr)
	if len(cr.Comments) != 2 || cr.Comments[1].ID <= cr.Comments[0].ID {
		t.Fatalf("comment ids must be monotonic: %+v", cr.Comments)
	}

	// An empty comment is a 400, named plainly.
	rec := doRaw(t, h, http.MethodPost, crPath+"/comments", map[string]any{"body": "   "})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty comment: want 400, got %d (%s)", rec.Code, rec.Body.String())
	}

	// Reviewer assignment replaces the list, trimming blanks and duplicates.
	doJSON(t, h, http.MethodPut, crPath+"/reviewers", map[string]any{
		"reviewers": []string{" carol ", "dave", "carol", ""},
	}, &cr)
	if len(cr.Reviewers) != 2 || cr.Reviewers[0] != "carol" || cr.Reviewers[1] != "dave" {
		t.Fatalf("unexpected reviewers: %+v", cr.Reviewers)
	}

	// Comments and reviewers ride along on the ordinary CR read.
	doJSON(t, h, http.MethodGet, crPath, nil, &cr)
	if len(cr.Comments) != 2 || len(cr.Reviewers) != 2 {
		t.Fatalf("persisted CR lost review data: %+v", cr)
	}

	// Unknown CR: 404.
	rec = doRaw(t, h, http.MethodPost, "/api/changes/999/comments", map[string]any{"body": "hello"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown CR: want 404, got %d", rec.Code)
	}
}
