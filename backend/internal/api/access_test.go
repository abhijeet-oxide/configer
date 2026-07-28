package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/gitengine"
	"github.com/abhijeet-oxide/configer/backend/internal/store"
)

// GitHub's permission ladder maps onto Configer's three capabilities: read is
// read, write is write, and the two levels that administer a repository are the
// two that may publish here.
func TestGitPermissionMapsOntoConfigerRoles(t *testing.T) {
	cases := []struct {
		name string
		p    gitPermissions
		want store.Role
		ok   bool
	}{
		{"admin", gitPermissions{Admin: true, Push: true, Pull: true}, store.RoleApprover, true},
		{"maintain", gitPermissions{Maintain: true, Push: true, Pull: true}, store.RoleApprover, true},
		{"write", gitPermissions{Push: true, Pull: true}, store.RoleEditor, true},
		{"triage", gitPermissions{Triage: true, Pull: true}, store.RoleViewer, true},
		{"read", gitPermissions{Pull: true}, store.RoleViewer, true},
		{"none", gitPermissions{}, "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := gitPermissionRole(c.p)
			if got != c.want || ok != c.ok {
				t.Fatalf("= %q,%v want %q,%v", got, ok, c.want, c.ok)
			}
		})
	}
}

// Only a GitHub origin can have its permissions mirrored; a local folder or
// another host has to fall through to the rest of the chain.
func TestGitHubFullNameRecognizesRealOrigins(t *testing.T) {
	cases := []struct {
		origin string
		want   string
		ok     bool
	}{
		{"https://github.com/acme/ran-config", "acme/ran-config", true},
		{"https://github.com/acme/ran-config.git", "acme/ran-config", true},
		{"https://x-access-token:ghp_secret@github.com/acme/ran-config.git", "acme/ran-config", true},
		{"git@github.com:acme/ran-config.git", "acme/ran-config", true},
		{"https://github.enterprise.internal/acme/ran-config", "acme/ran-config", true},
		{"https://gitlab.com/acme/ran-config", "", false},
		{"/srv/repos/ran-config", "", false},
		{"https://github.com/acme", "", false},
	}
	for _, c := range cases {
		got, ok := gitengine.GitHubFullName(c.origin)
		if got != c.want || ok != c.ok {
			t.Errorf("%q = %q,%v want %q,%v", c.origin, got, ok, c.want, c.ok)
		}
	}
}

// The chain answers in order, and says which source answered - a bare role is a
// question ("why am I a viewer?"), a role plus its source is an answer.
func TestGrantChainOrderAndSource(t *testing.T) {
	hub, _ := testHub(t)
	repoID := hub.registry.List()[0].ID
	req := func() *http.Request { return httptest.NewRequest(http.MethodGet, "/", nil) }

	// A deployment administrator outranks everything.
	if g := hub.grantFor(req(), repoID, store.User{Login: "root", Admin: true}); g.Role != store.RoleApprover || g.Source != "admin" {
		t.Errorf("admin grant = %+v", g)
	}
	// An explicit Configer grant wins over anything Git would say, so a
	// deliberate decision here is never silently undone by a change over there.
	if g := hub.grantFor(req(), repoID, store.User{Login: "eddy"}); g.Role != store.RoleEditor || g.Source != "configer" {
		t.Errorf("member grant = %+v", g)
	}
	// Nobody in particular, no per-user Git credential to mirror: the
	// deployment default, named as such.
	g := hub.grantFor(req(), repoID, store.User{Login: "stranger"})
	if g.Source != "default" {
		t.Errorf("fallback source = %q, want default", g.Source)
	}
	if g.Role != defaultRole() {
		t.Errorf("fallback role = %q, want the deployment default %q", g.Role, defaultRole())
	}
	if g.Detail == "" {
		t.Error("every grant must be able to explain itself")
	}
}

// ghPermissionStub stands in for GitHub: the permission block it returns
// depends on the token presented, so one server can play all three people.
func ghPermissionStub(t *testing.T, calls *int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/repos/acme/ran-config") {
			http.NotFound(w, r)
			return
		}
		*calls++
		tok := r.Header.Get("Authorization")
		perms := gitPermissions{Pull: true}
		switch {
		case strings.Contains(tok, "admin"):
			perms = gitPermissions{Admin: true, Maintain: true, Push: true, Pull: true}
		case strings.Contains(tok, "write"):
			perms = gitPermissions{Push: true, Pull: true}
		case strings.Contains(tok, "nobody"):
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"permissions": perms})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// End to end over a stand-in GitHub: the caller's OWN token decides what they
// may do here. Three people, three permissions on the same repository, three
// different capabilities in Configer - which is the whole point of the feature.
func TestGitPermissionsAreMirroredPerUser(t *testing.T) {
	t.Setenv("CONFIGER_DEFAULT_ROLE", "viewer") // so a mirrored role is never the default by accident

	var calls int
	hub, _ := testHub(t)
	hub.auth.APIBase = ghPermissionStub(t, &calls).URL

	// An application connected by URL: the workspace entry names the repository.
	seed := hub.registry.List()[0]
	seed.ID = "gh"
	seed.Origin = "https://github.com/acme/ran-config.git"
	if err := hub.registry.Add(seed); err != nil {
		t.Fatal(err)
	}

	req := func() *http.Request { return httptest.NewRequest(http.MethodGet, "/", nil) }
	for _, c := range []struct {
		login, token string
		want         store.Role
	}{
		{"ada", "gho_admin", store.RoleApprover},
		{"wendy", "gho_write", store.RoleEditor},
		{"raj", "gho_read", store.RoleViewer},
	} {
		hub.auth.SetGitHubToken(c.login, c.token)
		g := hub.grantFor(req(), "gh", store.User{Login: c.login})
		if g.Role != c.want || g.Source != "git" {
			t.Errorf("%s: grant = %+v, want %q from git", c.login, g, c.want)
		}
	}

	// Answered once per person and then remembered: authorization runs on every
	// repo-scoped request and must not become a GitHub call each time.
	before := calls
	hub.grantFor(req(), "gh", store.User{Login: "ada"})
	if calls != before {
		t.Errorf("a repeat grant asked GitHub again (%d -> %d)", before, calls)
	}
	// Until the person asks for it: forgetting their cached roles makes the next
	// request pick up a permission they have just changed on GitHub.
	hub.gitRoles.Forget("ada")
	hub.grantFor(req(), "gh", store.User{Login: "ada"})
	if calls == before {
		t.Error("after Forget the role should be read from GitHub again")
	}

	// Someone GitHub will not answer for has no mirrored role at all; the chain
	// carries on to the deployment default rather than inventing one.
	hub.auth.SetGitHubToken("nemo", "gho_nobody")
	if g := hub.grantFor(req(), "gh", store.User{Login: "nemo"}); g.Source != "default" {
		t.Errorf("unknown-to-GitHub grant = %+v, want the deployment default", g)
	}
	// And nobody signed in with no token of their own is never mirrored: a
	// shared server credential describes the service's access, not a person's.
	if g := hub.grantFor(req(), "gh", store.User{Login: "stranger"}); g.Source != "default" {
		t.Errorf("no-token grant = %+v, want the deployment default", g)
	}
}

// A folder opened in place records its PATH as the workspace origin, so the
// mirror has to ask the working tree what it is a clone of.
func TestLocalCloneOfAGitHubRepositoryIsStillMirrored(t *testing.T) {
	var calls int
	hub, _ := testHub(t)
	hub.auth.APIBase = ghPermissionStub(t, &calls).URL
	entry := hub.registry.List()[0]

	run := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = entry.Path
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("remote", "add", "origin", "https://github.com/acme/ran-config.git")
	if got := run("remote", "get-url", "origin"); !strings.Contains(got, "github.com/acme/ran-config") {
		// Some environments rewrite github.com URLs through a local mirror
		// (url.<base>.insteadOf), which is exactly what git is supposed to
		// report. There is nothing to mirror against then.
		t.Skipf("git rewrites the origin URL here (%s)", got)
	}

	hub.auth.SetGitHubToken("ada", "gho_admin")
	g := hub.grantFor(httptest.NewRequest(http.MethodGet, "/", nil), entry.ID, store.User{Login: "ada"})
	if g.Role != store.RoleApprover || g.Source != "git" {
		t.Errorf("local clone grant = %+v, want approver from git", g)
	}
}

// The default is full access, deliberately: it is reached when Configer cannot
// tell one signed-in person from another on this application, and refusing them
// all protects nothing. An operator can still tighten it.
func TestDefaultRoleIsFullAccessAndOverridable(t *testing.T) {
	t.Setenv("CONFIGER_DEFAULT_ROLE", "")
	if got := defaultRole(); got != store.RoleApprover {
		t.Fatalf("default = %q, want approver", got)
	}
	t.Setenv("CONFIGER_DEFAULT_ROLE", "viewer")
	if got := defaultRole(); got != store.RoleViewer {
		t.Fatalf("overridden default = %q, want viewer", got)
	}
}
