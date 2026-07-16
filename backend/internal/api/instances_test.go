package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestAddInstanceCloneScaffoldsImmediately verifies that adding a cloned
// instance creates a real parallel folder (a copy of the source's files) and a
// registry entry right away, and that the new instance's cells are editable in
// the grid - not deferred to a change-request submit.
func TestAddInstanceCloneScaffoldsImmediately(t *testing.T) {
	root := minimalRepo(t) // has instance "staging" with instances/staging/values.yaml (app.port: 8080)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	doJSON(t, h, http.MethodPost, "/api/instances", map[string]any{
		"name": "prod", "cloneFrom": "staging", "environment": "production",
	}, nil)

	// The parallel folder exists on disk with the copied file.
	b, err := os.ReadFile(filepath.Join(root, "instances", "prod", "values.yaml"))
	if err != nil {
		t.Fatalf("cloned folder not created: %v", err)
	}
	if !strings.Contains(string(b), "port: 8080") {
		t.Fatalf("cloned values not copied: %s", b)
	}

	// The registry carries the new instance.
	if p, _ := s.load(); func() bool { _, ok := p.InstanceByName("prod"); return !ok }() {
		t.Fatal("prod not in the registry after add")
	}

	// The grid shows prod as a real, editable column (not a pending draft).
	var grid struct {
		Instances []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"instances"`
		Rows []struct {
			Cells map[string]struct {
				Editable bool `json:"editable"`
				Pending  bool `json:"pending"`
			} `json:"cells"`
		} `json:"rows"`
	}
	doJSON(t, h, http.MethodGet, "/api/grid", nil, &grid)
	var found bool
	for _, i := range grid.Instances {
		if i.Name == "prod" {
			found = true
			if i.Status == "draft" {
				t.Fatal("prod should be a real instance, not a draft preview")
			}
		}
	}
	if !found {
		t.Fatal("prod column missing from the grid")
	}
	if len(grid.Rows) == 0 {
		t.Fatal("no rows")
	}
	cell := grid.Rows[0].Cells["prod"]
	if !cell.Editable || cell.Pending {
		t.Fatalf("prod cell should be editable and not pending, got %+v", cell)
	}
}
