package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// "Stop managing this parameter" rewrites .configer/parameters.yaml, so it is a
// CHANGE and travels the same road as every other one: staged on the draft,
// reviewed, published. Nothing happens to the catalog when the menu item is
// clicked - an earlier version committed straight to the branch, which put a
// change on Git that no review ever saw.
//
// What it does when it lands: the catalog entry goes, the value stays in the
// file byte for byte, and the path is remembered so the next scan does not offer
// it back.
func TestUnmanageParameterIsStagedThenApplied(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	values := filepath.Join(root, "instances", "staging", "values.yaml")
	before, err := os.ReadFile(values)
	if err != nil {
		t.Fatal(err)
	}

	// A pending edit to the same parameter, to prove it goes with it: applying a
	// value and then dropping the parameter that names it is not a change
	// anybody meant to make.
	doJSON(t, h, http.MethodPut, "/api/values", map[string]any{
		"instance": "staging", "paramId": "p1", "value": 9090,
	}, nil)

	var staged struct {
		OK      bool   `json:"ok"`
		Staged  string `json:"staged"`
		Pending int    `json:"pending"`
	}
	doJSON(t, h, http.MethodPost, "/api/parameters/p1/unmanage", map[string]any{"author": "t"}, &staged)
	if !staged.OK || staged.Staged != "p1" || staged.Pending != 1 {
		t.Fatalf("unmanage did not stage exactly one item: %+v", staged)
	}

	// NOTHING has happened yet: the catalog still carries it. That is the whole
	// point of routing it through the workflow.
	cat, err := os.ReadFile(filepath.Join(root, ".configer", "parameters.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(cat), "id: p1") {
		t.Fatalf("the catalog changed before the change was submitted:\n%s", cat)
	}

	// The draft carries it as a structural item, named in words.
	var draft struct {
		Draft *struct {
			ID    int `json:"id"`
			Items []struct {
				ParamID string `json:"paramId"`
				Action  string `json:"action"`
				New     any    `json:"new"`
			} `json:"items"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)
	if draft.Draft == nil || len(draft.Draft.Items) != 1 {
		t.Fatalf("draft = %+v, want the one unmanage item", draft.Draft)
	}
	if it := draft.Draft.Items[0]; it.Action != "unmanage-parameter" || it.ParamID != "p1" || it.New != "app.port" {
		t.Fatalf("staged item = %+v, want unmanage-parameter for p1 named app.port", it)
	}

	// Submitting and publishing applies it.
	crPath := "/api/changes/" + strconv.Itoa(draft.Draft.ID)
	if rec := doRaw(t, h, http.MethodPost, crPath+"/submit", map[string]any{
		"title": "Stop managing app.port", "author": "t",
	}); rec.Code != http.StatusAccepted {
		t.Fatalf("submit status = %d: %s", rec.Code, rec.Body.String())
	}
	var cr struct {
		State string `json:"state"`
	}
	doJSON(t, h, http.MethodGet, crPath, nil, &cr)
	if cr.State != "under_review" {
		t.Fatalf("submit left the change in %q", cr.State)
	}
	if rec := doRaw(t, h, http.MethodPost, crPath+"/merge", nil); rec.Code != http.StatusAccepted {
		t.Fatalf("merge status = %d: %s", rec.Code, rec.Body.String())
	}

	cat, err = os.ReadFile(filepath.Join(root, ".configer", "parameters.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(cat), "id: p1") {
		t.Errorf("the published change did not drop the catalog entry:\n%s", cat)
	}
	after, err := os.ReadFile(values)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Errorf("the configuration changed:\n--- before ---\n%s\n--- after ---\n%s", before, after)
	}
	ig, err := os.ReadFile(filepath.Join(root, ".configer", "ignore.yaml"))
	if err != nil {
		t.Fatalf("no ignore.yaml written: %v", err)
	}
	if !strings.Contains(string(ig), "$.app.port") {
		t.Errorf("ignore.yaml does not remember the path:\n%s", ig)
	}
}
