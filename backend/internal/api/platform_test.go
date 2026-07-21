package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/auth"
	"github.com/abhijeet-oxide/configer/backend/internal/store"
)

// minimalRepo writes the smallest valid write-back-native application and
// initializes it as a git repository.
func minimalRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, content string) {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(".configer/application.yaml", "apiVersion: configer.io/v1\nkind: Application\nname: t\nlayout: plain-folders\n")
	write(".configer/parameters.yaml", `
apiVersion: configer.io/v1
kind: ParameterCatalog
parameters:
  - id: p1
    name: app.port
    category: General
    type: integer
    scope: instance
    bindings:
      - { file: "{folder}/values.yaml", path: $.app.port, format: yaml }
`)
	write(".configer/instances.yaml", "apiVersion: configer.io/v1\nkind: InstanceRegistry\ninstances:\n  - { name: staging, folder: instances/staging }\n")
	write("instances/staging/values.yaml", "app:\n  port: 8080\n")
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"}, {"add", "-A"},
		{"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	return root
}

// testHub builds a Hub over a minimal repo with OAuth artificially enabled,
// plus two sessions: an editor and an approver-with-admin.
func testHub(t *testing.T) (*Hub, http.Handler) {
	t.Helper()
	repo := minimalRepo(t)
	dataDir := t.TempDir()
	hub, err := NewHub(dataDir, repo, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = hub.Close() })

	// Force-enable auth (no real GitHub round-trip in tests).
	hub.auth = &auth.Service{ClientID: "test-client", Store: hub.platform}
	ctx := context.Background()
	users := []struct {
		login string
		admin bool
		token string
	}{
		{"eddy", false, "tok-editor"},
		{"root", true, "tok-admin"},
	}
	for _, u := range users {
		if err := hub.platform.UpsertUser(ctx, store.User{Login: u.login, Admin: u.admin, CreatedAt: time.Now()}); err != nil {
			t.Fatal(err)
		}
		if err := hub.platform.CreateSession(ctx, u.token, u.login, time.Hour); err != nil {
			t.Fatal(err)
		}
	}
	// The deployment default role is viewer (least privilege), so grant the
	// non-admin an explicit editor role for the write-path assertions.
	repoID := hub.registry.List()[0].ID
	if err := hub.platform.SetMember(ctx, store.Member{Repo: repoID, Login: "eddy", Role: store.RoleEditor}); err != nil {
		t.Fatal(err)
	}
	return hub, hub.Routes()
}

func call(t *testing.T, h http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	if token != "" {
		r.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: token})
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestRoleEnforcement(t *testing.T) {
	hub, h := testHub(t)
	repoID := hub.registry.List()[0].ID
	base := "/api/repos/" + repoID

	// Unauthenticated requests are rejected when login is enabled.
	if w := call(t, h, "GET", base+"/grid", "", ""); w.Code != http.StatusUnauthorized {
		t.Errorf("anonymous read = %d, want 401", w.Code)
	}
	// An explicit editor reads and edits.
	if w := call(t, h, "GET", base+"/grid", "tok-editor", ""); w.Code != http.StatusOK {
		t.Errorf("editor read = %d: %s", w.Code, w.Body.String())
	}
	if w := call(t, h, "PUT", base+"/values", "tok-editor",
		`{"instance":"staging","paramId":"p1","value":9090}`); w.Code != http.StatusOK {
		t.Errorf("editor write = %d: %s", w.Code, w.Body.String())
	}
	// Publishing needs the approver role: the editor is denied.
	if w := call(t, h, "POST", base+"/changes/1/merge", "tok-editor", ""); w.Code != http.StatusForbidden {
		t.Errorf("editor merge = %d, want 403: %s", w.Code, w.Body.String())
	}
	// Demote the editor to viewer: writes are denied too.
	if err := hub.platform.SetMember(context.Background(), store.Member{Repo: repoID, Login: "eddy", Role: store.RoleViewer}); err != nil {
		t.Fatal(err)
	}
	if w := call(t, h, "PUT", base+"/values", "tok-editor",
		`{"instance":"staging","paramId":"p1","value":9091}`); w.Code != http.StatusForbidden {
		t.Errorf("viewer write = %d, want 403", w.Code)
	}
	if w := call(t, h, "GET", base+"/grid", "tok-editor", ""); w.Code != http.StatusOK {
		t.Errorf("viewer read = %d, want 200", w.Code)
	}

	// Anyone signed in can read their OWN effective role (here: the demoted
	// viewer); anonymous callers cannot.
	if w := call(t, h, "GET", base+"/role", "tok-editor", ""); w.Code != http.StatusOK ||
		!strings.Contains(w.Body.String(), `"role":"viewer"`) {
		t.Errorf("own role = %d %s, want 200 with role viewer", w.Code, w.Body.String())
	}
	if w := call(t, h, "GET", base+"/role", "", ""); w.Code != http.StatusUnauthorized {
		t.Errorf("anonymous role = %d, want 401", w.Code)
	}
	if w := call(t, h, "GET", base+"/role", "tok-admin", ""); w.Code != http.StatusOK ||
		!strings.Contains(w.Body.String(), `"admin":true`) {
		t.Errorf("admin role = %d %s, want 200 with admin true", w.Code, w.Body.String())
	}

	// Member management is admin-only.
	if w := call(t, h, "PUT", base+"/members", "tok-editor",
		`{"login":"eddy","role":"approver"}`); w.Code != http.StatusForbidden {
		t.Errorf("non-admin member set = %d, want 403", w.Code)
	}
	if w := call(t, h, "PUT", base+"/members", "tok-admin",
		`{"login":"eddy","role":"approver"}`); w.Code != http.StatusOK {
		t.Errorf("admin member set = %d: %s", w.Code, w.Body.String())
	}
	// The promoted approver may now hit merge (404/409 for the missing CR is
	// fine - the gate is what we test).
	if w := call(t, h, "POST", base+"/changes/99/merge", "tok-editor", ""); w.Code == http.StatusForbidden {
		t.Errorf("approver merge still forbidden: %s", w.Body.String())
	}

	// The audit trail recorded the successful write.
	evs, err := hub.platform.Events(context.Background(), repoID, 10)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range evs {
		// The action is humanized; the raw endpoint stays in the detail.
		if e.Login == "eddy" && strings.Contains(e.Detail, "/values") && e.Action == "Edited a configuration value" {
			found = true
		}
	}
	if !found {
		t.Errorf("audit trail missing the editor's write: %+v", evs)
	}
}

func TestSingleUserModeUnchanged(t *testing.T) {
	repo := minimalRepo(t)
	hub, err := NewHub(t.TempDir(), repo, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = hub.Close() })
	h := hub.Routes()

	// No OAuth configured: anonymous requests keep working (self-hosted mode).
	if w := call(t, h, "GET", "/api/grid", "", ""); w.Code != http.StatusOK {
		t.Errorf("single-user read = %d: %s", w.Code, w.Body.String())
	}
	if w := call(t, h, "GET", "/api/auth/me", "", ""); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"enabled":false`) {
		t.Errorf("auth/me = %d %s", w.Code, w.Body.String())
	}
	// The role probe reflects single-user mode: every capability, no login.
	repoID := hub.registry.List()[0].ID
	if w := call(t, h, "GET", "/api/repos/"+repoID+"/role", "", ""); w.Code != http.StatusOK ||
		!strings.Contains(w.Body.String(), `"enabled":false`) ||
		!strings.Contains(w.Body.String(), `"role":"approver"`) {
		t.Errorf("single-user role = %d %s", w.Code, w.Body.String())
	}
}

func TestHumanizeAction(t *testing.T) {
	cases := []struct{ method, path, want string }{
		{"PUT", "/values", "Edited a configuration value"},
		{"POST", "/instances", "Added an instance"},
		{"DELETE", "/instances/dev", "Retired instance dev"},
		{"POST", "/changes/3/submit", "Submitted change request #3 for review"},
		{"POST", "/changes/3/merge", "Published change request #3"},
		{"POST", "/changes/3/reject", "Rejected change request #3"},
		{"POST", "/import", "Imported settings"},
		{"POST", "/repo/sync", "Synchronized with Git"},
		{"PUT", "/parameters/net-mtu", "Updated a parameter"},
	}
	for _, c := range cases {
		if got := humanizeAction(c.method, c.path); got != c.want {
			t.Errorf("humanizeAction(%q, %q) = %q, want %q", c.method, c.path, got, c.want)
		}
	}
}
