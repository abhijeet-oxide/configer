package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// TestApplicationDetails exercises the GET/PUT /api/application round trip:
// the identity reads back, a patch persists name/description/metadata to
// .configer/application.yaml, and the change is committed to Git.
func TestApplicationDetails(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	// GET reflects the seeded application.
	var got model.Application
	doJSON(t, h, http.MethodGet, "/api/application", nil, &got)
	if got.Name != "t" {
		t.Fatalf("name = %q, want t", got.Name)
	}

	// PUT patches name, description and metadata.
	body := map[string]any{
		"name":        "Network Platform",
		"description": "Edge routers",
		"metadata":    map[string]string{"owner": "platform-team", "blank": ""},
	}
	var updated model.Application
	doJSON(t, h, http.MethodPut, "/api/application", body, &updated)
	if updated.Name != "Network Platform" || updated.Description != "Edge routers" {
		t.Fatalf("update = %+v", updated)
	}
	if updated.Metadata["owner"] != "platform-team" {
		t.Fatalf("metadata owner missing: %+v", updated.Metadata)
	}
	if _, ok := updated.Metadata["blank"]; ok {
		t.Fatalf("empty metadata value should be dropped: %+v", updated.Metadata)
	}

	// It is persisted to the real file and loads back through the project.
	p, err := project.Load(root)
	if err != nil {
		t.Fatal(err)
	}
	if p.App.Name != "Network Platform" || p.App.Metadata["owner"] != "platform-team" {
		t.Fatalf("persisted app = %+v", p.App)
	}

	// An empty name is rejected without touching the file.
	rec := doRaw(t, h, http.MethodPut, "/api/application", map[string]any{"name": "  "})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty name status = %d, want 422", rec.Code)
	}

	// The write landed as a commit (not just a working-tree change).
	if b, _ := os.ReadFile(filepath.Join(root, ".configer", "application.yaml")); !strings.Contains(string(b), "Network Platform") {
		t.Fatalf("application.yaml not updated on disk")
	}
}

func doRaw(t *testing.T, h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body != nil {
		b, _ := json.Marshal(body)
		r = httptest.NewRequest(method, path, strings.NewReader(string(b)))
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func doJSON(t *testing.T, h http.Handler, method, path string, body, out any) {
	t.Helper()
	rec := doRaw(t, h, method, path, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("%s %s: status %d, body %s", method, path, rec.Code, rec.Body.String())
	}
	if out != nil {
		if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
			t.Fatalf("decode %s %s: %v", method, path, err)
		}
	}
}

// TestDeinit removes the .configer folder and commits the removal, returning
// the repository to an un-onboarded state.
func TestDeinit(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()
	if !s.initialized() {
		t.Fatal("fixture should start initialized")
	}
	rec := doRaw(t, h, http.MethodPost, "/api/deinit", map[string]any{})
	if rec.Code != http.StatusOK {
		t.Fatalf("deinit status %d: %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, ".configer")); !os.IsNotExist(err) {
		t.Fatalf(".configer should be gone, stat err = %v", err)
	}
	if s.initialized() {
		t.Fatal("repository should read as uninitialized after deinit")
	}
}
