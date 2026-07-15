package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// TestBrowseFolders checks the local folder picker: only sub-directories are
// listed (not files or dotfolders), a git working tree is flagged, and the
// parent path is offered so the picker can navigate up.
func TestBrowseFolders(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "project", ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "notes"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, ".hidden"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "readme.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	h := &Hub{}
	rec := httptest.NewRecorder()
	h.browseFolders(rec, httptest.NewRequest(http.MethodGet, "/api/fs/browse?path="+root, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Path    string `json:"path"`
		Parent  string `json:"parent"`
		Folders []struct {
			Name   string `json:"name"`
			IsRepo bool   `json:"isRepo"`
		} `json:"folders"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Path != root {
		t.Fatalf("path = %q, want %q", out.Path, root)
	}
	if out.Parent != filepath.Dir(root) {
		t.Fatalf("parent = %q, want %q", out.Parent, filepath.Dir(root))
	}
	byName := map[string]bool{}
	for _, f := range out.Folders {
		byName[f.Name] = f.IsRepo
	}
	if len(out.Folders) != 2 {
		t.Fatalf("folders = %v, want exactly project + notes", out.Folders)
	}
	if !byName["project"] {
		t.Fatalf("project should be flagged as a git repo: %v", out.Folders)
	}
	if _, ok := byName["notes"]; !ok {
		t.Fatalf("notes folder missing: %v", out.Folders)
	}
	if _, ok := byName[".hidden"]; ok {
		t.Fatalf("dotfolders must be hidden: %v", out.Folders)
	}
	if _, ok := byName["readme.txt"]; ok {
		t.Fatalf("files must not be listed: %v", out.Folders)
	}

	// A non-existent path is a clean 400, not a panic.
	rec = httptest.NewRecorder()
	h.browseFolders(rec, httptest.NewRequest(http.MethodGet, "/api/fs/browse?path="+filepath.Join(root, "nope"), nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing path status = %d, want 400", rec.Code)
	}
}
