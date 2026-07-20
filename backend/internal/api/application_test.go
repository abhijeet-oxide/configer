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

	// GET reflects the seeded application and carries a concurrency token.
	recGet := doRaw(t, h, http.MethodGet, "/api/application", nil)
	if recGet.Code != http.StatusOK {
		t.Fatalf("GET status %d", recGet.Code)
	}
	etag := recGet.Header().Get("ETag")
	if etag == "" {
		t.Fatal("GET /application should return an ETag")
	}
	var got model.Application
	if err := json.Unmarshal(recGet.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Name != "t" {
		t.Fatalf("name = %q, want t", got.Name)
	}

	// A write without If-Match is refused (428): the guard is mandatory.
	if rec := doRaw(t, h, http.MethodPut, "/api/application", map[string]any{"description": "x"}); rec.Code != http.StatusPreconditionRequired {
		t.Fatalf("missing If-Match status = %d, want 428", rec.Code)
	}
	// A write with a stale revision is refused (412).
	if rec := doRawH(t, h, http.MethodPut, "/api/application", map[string]any{"description": "x"},
		map[string]string{"If-Match": `"deadbeef"`}); rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale If-Match status = %d, want 412", rec.Code)
	}

	// PUT patches name, description and metadata, with the current revision.
	body := map[string]any{
		"name":        "Network Platform",
		"description": "Edge routers",
		"metadata":    map[string]string{"owner": "platform-team", "blank": ""},
	}
	var updated model.Application
	recPut := doRawH(t, h, http.MethodPut, "/api/application", body, map[string]string{"If-Match": etag})
	if recPut.Code != http.StatusOK {
		t.Fatalf("PUT status %d: %s", recPut.Code, recPut.Body.String())
	}
	if err := json.Unmarshal(recPut.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
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
	return doRawH(t, h, method, path, body, nil)
}

// doRawH is doRaw with request headers (for If-Match, etc.).
func doRawH(t *testing.T, h http.Handler, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body != nil {
		b, _ := json.Marshal(body)
		r = httptest.NewRequest(method, path, strings.NewReader(string(b)))
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
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
