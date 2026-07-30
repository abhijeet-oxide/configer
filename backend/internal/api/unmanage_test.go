package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Unmanaging a parameter takes it out of the grid and leaves the configuration
// alone: the catalog entry goes, the value stays in the file byte for byte, and
// the path is remembered so the next scan does not offer it back. That last part
// is what makes it stick; without it "stop managing this" lasts until the next
// import.
func TestUnmanageParameterKeepsTheValue(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	before, err := os.ReadFile(filepath.Join(root, "instances", "staging", "values.yaml"))
	if err != nil {
		t.Fatal(err)
	}

	// A pending edit to it, to prove those go too (they would point at a
	// parameter nobody manages).
	doJSON(t, h, http.MethodPut, "/api/values", map[string]any{
		"instance": "staging", "paramId": "p1", "value": 9090,
	}, nil)

	var out struct {
		OK        bool   `json:"ok"`
		Unmanaged string `json:"unmanaged"`
	}
	doJSON(t, h, http.MethodPost, "/api/parameters/p1/unmanage", map[string]any{"author": "t"}, &out)
	if !out.OK || out.Unmanaged != "p1" {
		t.Fatalf("unmanage did not report the parameter: %+v", out)
	}

	// The file is untouched.
	after, err := os.ReadFile(filepath.Join(root, "instances", "staging", "values.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Errorf("the configuration changed:\n--- before ---\n%s\n--- after ---\n%s", before, after)
	}

	// The catalog no longer carries it, and the grid no longer shows it.
	cat, err := os.ReadFile(filepath.Join(root, ".configer", "parameters.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(cat), "id: p1") {
		t.Errorf("catalog still holds the parameter:\n%s", cat)
	}
	var grid struct {
		Rows []struct {
			Param struct {
				ID string `json:"id"`
			} `json:"param"`
		} `json:"rows"`
	}
	doJSON(t, h, http.MethodGet, "/api/grid", nil, &grid)
	for _, r := range grid.Rows {
		if r.Param.ID == "p1" {
			t.Error("the grid still shows the unmanaged parameter")
		}
	}

	// The path is remembered, so a rescan does not propose it again.
	ig, err := os.ReadFile(filepath.Join(root, ".configer", "ignore.yaml"))
	if err != nil {
		t.Fatalf("no ignore.yaml written: %v", err)
	}
	if !strings.Contains(string(ig), "$.app.port") {
		t.Errorf("ignore.yaml does not remember the path:\n%s", ig)
	}

	// And the staged edit to it is gone rather than pointing at nothing.
	var draft struct {
		Draft *struct {
			Items []struct {
				ParamID string `json:"paramId"`
			} `json:"items"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)
	if draft.Draft != nil {
		for _, it := range draft.Draft.Items {
			if it.ParamID == "p1" {
				t.Error("a pending edit to the unmanaged parameter survived")
			}
		}
	}
}
