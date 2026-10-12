package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/abhijeet-oxide/configer/internal/auth"
	"github.com/abhijeet-oxide/softwareGateway/pkg/authz"
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

// policy stands in for the platform's Cerbos: each subject holds a set of
// actions per resource kind, and every question asked is recorded.
type policy struct {
	mu     sync.Mutex
	grants map[string]map[string]bool // subject -> "kind:action"
	asked  []string                   // "kind:action:product"
}

func (p *policy) grant(subject, kind string, actions ...string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.grants[subject] == nil {
		p.grants[subject] = map[string]bool{}
	}
	for _, a := range actions {
		p.grants[subject][kind+":"+a] = true
	}
}

func (p *policy) Check(_ context.Context, id authz.Identity, res authz.Resource, actions ...string) (map[string]bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := map[string]bool{}
	for _, a := range actions {
		p.asked = append(p.asked, res.Kind+":"+a+":"+res.Product)
		out[a] = p.grants[id.Subject][res.Kind+":"+a]
	}
	return out, nil
}

func (p *policy) lastAsked() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.asked) == 0 {
		return ""
	}
	return p.asked[len(p.asked)-1]
}

// testHub builds a Hub over a minimal repo with sign-in on: a bearer token is
// the subject's name, and the policy decides everything.
func testHub(t *testing.T) (*Hub, http.Handler, *policy) {
	t.Helper()
	repo := minimalRepo(t)
	hub, err := NewHub(t.TempDir(), repo, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = hub.Close() })
	// Background work (the warmer, each application's sync loop) still writes
	// under .git after a short test returns, and the temporary directory's
	// removal then fails. Wait the warmer out and stop the loops first.
	t.Cleanup(func() {
		for _, e := range hub.registry.List() {
			hub.opens.lock(e.ID)()
		}
		hub.mu.Lock()
		for _, s := range hub.servers {
			s.StopSync()
		}
		hub.mu.Unlock()
	})
	pol := &policy{grants: map[string]map[string]bool{}}
	hub.auth = &auth.Service{
		Store:     hub.platform,
		Engine:    pol,
		AdminRole: "org-admin",
		Verify: func(_ context.Context, raw string) (authz.Identity, error) {
			if raw == "forged" {
				return authz.Identity{}, errors.New("bad signature")
			}
			id := authz.Identity{Subject: raw, Email: raw + "@example.com", Name: raw, Method: "oidc"}
			if raw == "root" {
				id.OrgRoles = []string{"org-admin"}
			}
			return id, nil
		},
	}
	pol.grant("root", kindWorkspace, actCreateApplication, actViewAudit)
	pol.grant("root", kindApplication, actView, actEdit, actSubmit, actApprove, actPublish, actReject, actAdminister)
	return hub, hub.Routes(), pol
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
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// Incident guarded: role logic living in ArtiAuto's code, where the platform's
// policies could not reach it. Every request must arrive at the policy engine
// as the action the platform's policies are written against.
func TestEveryRequestIsAskedAsANamedAction(t *testing.T) {
	hub, h, pol := testHub(t)
	repoID := hub.registry.List()[0].ID
	base := "/api/repos/" + repoID
	for _, c := range []struct{ method, path, want string }{
		{"GET", base + "/grid", "artiauto_application:view:"},
		{"PUT", base + "/values", "artiauto_application:edit:"},
		{"POST", base + "/changes/4/submit", "artiauto_application:submit:"},
		{"POST", base + "/changes/4/approve", "artiauto_application:approve:"},
		{"POST", base + "/changes/4/merge", "artiauto_application:publish:"},
		{"POST", base + "/changes/4/reject", "artiauto_application:reject:"},
		{"PUT", base + "/application", "artiauto_application:administer:"},
		{"POST", base + "/sources", "artiauto_application:administer:"},
		{"POST", base + "/discover", "artiauto_application:view:"},
		{"PATCH", "/api/repos/" + repoID, "artiauto_application:administer:"},
		{"POST", "/api/repos", "artiauto_workspace:create_application:"},
		{"GET", "/api/audit", "artiauto_workspace:view_audit:"},
	} {
		w := call(t, h, c.method, c.path, "nobody", "{}")
		if w.Code != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403 for a person holding nothing", c.method, c.path, w.Code)
		}
		if got := pol.lastAsked(); got != c.want {
			t.Errorf("%s %s asked %q, want %q", c.method, c.path, got, c.want)
		}
	}
}

func TestSignInIsRequiredAndForgedTokensAreRefused(t *testing.T) {
	hub, h, _ := testHub(t)
	base := "/api/repos/" + hub.registry.List()[0].ID
	if w := call(t, h, "GET", base+"/grid", "", ""); w.Code != http.StatusUnauthorized {
		t.Errorf("anonymous read = %d, want 401", w.Code)
	}
	if w := call(t, h, "GET", base+"/grid", "forged", ""); w.Code != http.StatusUnauthorized {
		t.Errorf("forged token = %d, want 401", w.Code)
	}
	if w := call(t, h, "GET", "/api/health", "", ""); w.Code != http.StatusOK {
		t.Errorf("health without a token = %d, want 200", w.Code)
	}
}

func TestPolicyDecidesReadsWritesAndPublishing(t *testing.T) {
	hub, h, pol := testHub(t)
	repoID := hub.registry.List()[0].ID
	base := "/api/repos/" + repoID
	pol.grant("eddy", kindApplication, actView, actEdit)

	if w := call(t, h, "GET", base+"/grid", "eddy", ""); w.Code != http.StatusOK {
		t.Errorf("read = %d: %s", w.Code, w.Body.String())
	}
	if w := call(t, h, "PUT", base+"/values", "eddy",
		`{"instance":"staging","paramId":"p1","value":9090}`); w.Code != http.StatusOK {
		t.Errorf("write = %d: %s", w.Code, w.Body.String())
	}
	w := call(t, h, "POST", base+"/changes/1/merge", "eddy", "")
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "publish changes") {
		t.Errorf("publish = %d %s, want 403 naming what was refused", w.Code, w.Body.String())
	}
	if w := call(t, h, "GET", base+"/role", "eddy", ""); !strings.Contains(w.Body.String(), `"role":"editor"`) {
		t.Errorf("derived role = %s, want editor", w.Body.String())
	}
	pol.grant("eddy", kindApplication, actPublish)
	if w := call(t, h, "GET", base+"/role", "eddy", ""); !strings.Contains(w.Body.String(), `"role":"approver"`) {
		t.Errorf("derived role = %s, want approver", w.Body.String())
	}

	evs, err := hub.platform.Events(context.Background(), repoID, 10)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range evs {
		if e.Login == "eddy@example.com" && e.Action == "Edited a configuration value" {
			found = true
		}
	}
	if !found {
		t.Errorf("audit trail missing the write, named by the signed-in person: %+v", evs)
	}
}

// An application nobody let you see is not on your portfolio at all.
func TestPortfolioListsOnlyWhatYouMaySee(t *testing.T) {
	hub, h, pol := testHub(t)
	if w := call(t, h, "GET", "/api/repos", "vera", ""); strings.Contains(w.Body.String(), hub.registry.List()[0].ID) {
		t.Errorf("an application vera may not view is listed: %s", w.Body.String())
	}
	pol.grant("vera", kindApplication, actView)
	if w := call(t, h, "GET", "/api/repos", "vera", ""); !strings.Contains(w.Body.String(), `"role":"viewer"`) {
		t.Errorf("an application vera may view is missing: %s", w.Body.String())
	}
}

// A product role reaches an application through the product the application
// names in its own metadata.
func TestApplicationCarriesItsProductToThePolicy(t *testing.T) {
	hub, h, pol := testHub(t)
	repoID := hub.registry.List()[0].ID
	hub.ensureOpen(repoID)
	s, _ := hub.server(repoID)
	app := "apiVersion: configer.io/v1\nkind: Application\nname: t\nlayout: plain-folders\nmetadata:\n  product: sbc\n"
	if err := os.WriteFile(filepath.Join(s.RepoPath, ".configer", "application.yaml"), []byte(app), 0o644); err != nil {
		t.Fatal(err)
	}
	call(t, h, "GET", "/api/repos/"+repoID+"/grid", "eddy", "")
	if got := pol.lastAsked(); got != "artiauto_application:view:sbc" {
		t.Errorf("asked %q, want the product sbc on the resource", got)
	}
}

func TestAdministratorFlagComesFromTheOrganizationRole(t *testing.T) {
	hub, h, _ := testHub(t)
	repoID := hub.registry.List()[0].ID
	if w := call(t, h, "GET", "/api/repos/"+repoID+"/role", "root", ""); !strings.Contains(w.Body.String(), `"admin":true`) {
		t.Errorf("org-admin role = %s, want admin true", w.Body.String())
	}
	if w := call(t, h, "GET", "/api/repos/"+repoID+"/role", "eddy", ""); !strings.Contains(w.Body.String(), `"admin":false`) {
		t.Errorf("plain person = %s, want admin false", w.Body.String())
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
