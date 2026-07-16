package api

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// TestAddInstanceStagesAsPendingChange verifies that adding a cloned instance
// does NOT touch the working tree: it stages a pending structural change on
// the draft (feature branch), the folder is only previewed, and the grid shows
// the new instance as a pending "draft" column. The real folder materializes
// only when the change request is submitted.
func TestAddInstanceStagesAsPendingChange(t *testing.T) {
	root := minimalRepo(t) // has instance "staging" with instances/staging/values.yaml (app.port: 8080)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	doJSON(t, h, http.MethodPost, "/api/instances", map[string]any{
		"name": "prod", "cloneFrom": "staging", "environment": "production",
	}, nil)

	// Nothing is written to the working tree yet - the add is pending.
	if _, err := os.Stat(filepath.Join(root, "instances", "prod", "values.yaml")); !os.IsNotExist(err) {
		t.Fatalf("cloned folder should not exist on disk before submit, stat err = %v", err)
	}

	// The registry does not carry the new instance yet either.
	if p, _ := s.load(); func() bool { _, ok := p.InstanceByName("prod"); return ok }() {
		t.Fatal("prod should not be committed to the registry before submit")
	}

	// The draft carries exactly one pending add-instance item on a feature branch.
	var draftResp struct {
		Draft struct {
			Branch string `json:"branch"`
			Items  []struct {
				Instance string `json:"instance"`
				Action   string `json:"action"`
			} `json:"items"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draftResp)
	if draftResp.Draft.Branch != "feature/unnamed" {
		t.Fatalf("draft should ride feature/unnamed, got %q", draftResp.Draft.Branch)
	}
	if len(draftResp.Draft.Items) != 1 || draftResp.Draft.Items[0].Action != "add-instance" || draftResp.Draft.Items[0].Instance != "prod" {
		t.Fatalf("expected one pending add-instance for prod, got %+v", draftResp.Draft.Items)
	}

	// The grid previews prod as a pending draft column (cells pending).
	var grid struct {
		Instances []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"instances"`
		Rows []struct {
			Cells map[string]struct {
				Pending bool `json:"pending"`
			} `json:"cells"`
		} `json:"rows"`
	}
	doJSON(t, h, http.MethodGet, "/api/grid", nil, &grid)
	var found bool
	for _, i := range grid.Instances {
		if i.Name == "prod" {
			found = true
			if i.Status != "draft" {
				t.Fatalf("prod should be a pending draft preview, got status %q", i.Status)
			}
		}
	}
	if !found {
		t.Fatal("prod column missing from the grid preview")
	}
	if len(grid.Rows) == 0 {
		t.Fatal("no rows")
	}
	if !grid.Rows[0].Cells["prod"].Pending {
		t.Fatalf("prod cell should be pending, got %+v", grid.Rows[0].Cells["prod"])
	}
}

// TestPendingInstanceFilesPreview verifies the Files explorer can render a
// pending (draft-added) instance's folder before submit.
func TestPendingInstanceFilesPreview(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	doJSON(t, h, http.MethodPost, "/api/instances", map[string]any{
		"name": "prod", "cloneFrom": "staging",
	}, nil)

	var render struct {
		Files []struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		} `json:"files"`
	}
	doJSON(t, h, http.MethodGet, "/api/render/prod", nil, &render)
	var seen bool
	for _, f := range render.Files {
		if f.Path == "instances/prod/values.yaml" {
			seen = true
		}
	}
	if !seen {
		t.Fatalf("expected pending folder instances/prod/values.yaml in render preview, got %+v", render.Files)
	}
}
