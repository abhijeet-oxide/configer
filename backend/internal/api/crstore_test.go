package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/crstore"

	_ "modernc.org/sqlite" // sqlite driver (pure Go)
)

// TestDatabaseBackedChangeStoreServesTheWholeFlow drives the ordinary editing
// path over the database-backed store, through the real HTTP surface. The unit
// tests in crstore prove the two implementations agree on the contract; this
// proves the api layer only ever uses that contract, so a deployment on
// Postgres is the same product as one on a file.
func TestDatabaseBackedChangeStoreServesTheWholeFlow(t *testing.T) {
	root := twoInstanceRepo(t)

	dsn := "file:" + filepath.Join(t.TempDir(), "platform.db") + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	defer func() { _ = db.Close() }()

	crs, err := crstore.NewSQL(db, "sqlite", "app-under-test")
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewWithStore(root, false, crs)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	// Stage two edits: the second must land in the SAME draft as the first.
	doJSON(t, h, http.MethodPut, "/api/values", map[string]any{
		"paramId": "p-port", "instance": "staging", "value": 9090, "author": "alice",
	}, nil)
	doJSON(t, h, http.MethodPut, "/api/values", map[string]any{
		"paramId": "p-port", "instance": "prod", "value": 9091, "author": "alice",
	}, nil)

	var draft struct {
		Draft struct {
			ID    int `json:"id"`
			Items []struct {
				Instance string `json:"instance"`
			} `json:"items"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)
	if draft.Draft.ID == 0 {
		t.Fatal("no draft change request after staging an edit")
	}
	if len(draft.Draft.Items) != 2 {
		t.Fatalf("draft holds %d items, want the 2 that were staged", len(draft.Draft.Items))
	}

	// Submitting turns it into a branch, and the change leaves the draft state.
	var submitted struct {
		State  string `json:"state"`
		Branch string `json:"branch"`
		Number int    `json:"number"`
	}
	// Submit answers 202: the branch, commit and pull request continue on the
	// host and the client polls for the resulting state.
	rec := doRaw(t, h, http.MethodPost, "/api/changes/"+itoa(draft.Draft.ID)+"/submit", map[string]any{
		"title": "Bump ports", "author": "alice", "reference": "JIRA-9", "category": "feature",
	})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("submit: status %d, body %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &submitted); err != nil {
		t.Fatal(err)
	}
	if submitted.State != "under_review" {
		t.Fatalf("state after submit = %q, want under_review", submitted.State)
	}
	// Single-user, so no owner segment: the kind of change, the CR number it
	// was just given, and the words the author used.
	if submitted.Branch != "feature/cr-1-bump-ports" {
		t.Fatalf("branch = %q, want feature/cr-1-bump-ports", submitted.Branch)
	}
	if submitted.Number != 1 {
		t.Fatalf("number = %d, want the first CR number to be 1", submitted.Number)
	}

	// Classification set at submit time must have been persisted. It used to
	// survive only because the store handed back the object it kept.
	stored, err := crs.Get(draft.Draft.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Reference != "JIRA-9" || stored.Category != "feature" {
		t.Errorf("reference/category lost on submit: %q / %q", stored.Reference, stored.Category)
	}

	// The submitted change is no longer an open draft, so the next edit starts
	// a fresh one.
	var after struct {
		Draft *struct {
			ID int `json:"id"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &after)
	if after.Draft != nil {
		t.Errorf("a submitted change is still showing as the open draft (#%d)", after.Draft.ID)
	}
}
