package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/auth"
)

// A hub whose GitHub API points at a stub server; the server-wide token
// stands in for a signed-in user (the credential resolution is shared).
func stubHub(t *testing.T, ghURL string) *Hub {
	t.Helper()
	return &Hub{auth: &auth.Service{APIBase: ghURL}}
}

func TestGitHubStatusWithoutAnyCredential(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "")
	t.Setenv("CONFIGER_GITHUB_TOKEN", "")
	h := stubHub(t, "http://unused")
	rec := httptest.NewRecorder()
	h.githubStatus(rec, httptest.NewRequest(http.MethodGet, "/api/github/status", nil))
	var got struct {
		Available     bool   `json:"available"`
		Source        string `json:"source"`
		SignInEnabled bool   `json:"signInEnabled"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Available || got.Source != "" || got.SignInEnabled {
		t.Fatalf("expected browsing unavailable, got %+v", got)
	}

	// Browsing endpoints answer 401 with a plain-words message.
	rec = httptest.NewRecorder()
	h.githubRepos(rec, httptest.NewRequest(http.MethodGet, "/api/github/repos", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("repos without credential: got HTTP %d, want 401", rec.Code)
	}
}

func TestGitHubReposAndBranches(t *testing.T) {
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer server-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/user/repos":
			fmt.Fprint(w, `[{"full_name":"acme/net-config","name":"net-config","private":true,
				"description":"network configs","default_branch":"main",
				"pushed_at":"2026-01-02T03:04:05Z","html_url":"https://github.com/acme/net-config",
				"owner":{"login":"acme"}}]`)
		case "/repos/acme/net-config":
			fmt.Fprint(w, `{"default_branch":"main"}`)
		case "/repos/acme/net-config/branches":
			fmt.Fprint(w, `[{"name":"main"},{"name":"release/v24"}]`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer gh.Close()
	t.Setenv("CONFIGER_GITHUB_TOKEN", "server-token")
	h := stubHub(t, gh.URL)

	rec := httptest.NewRecorder()
	h.githubStatus(rec, httptest.NewRequest(http.MethodGet, "/api/github/status", nil))
	var status struct {
		Available bool   `json:"available"`
		Source    string `json:"source"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if !status.Available || status.Source != "server" {
		t.Fatalf("status = %+v, want available via server token", status)
	}

	rec = httptest.NewRecorder()
	h.githubRepos(rec, httptest.NewRequest(http.MethodGet, "/api/github/repos", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("repos: HTTP %d: %s", rec.Code, rec.Body)
	}
	var repos struct {
		Repos []GitHubRepo `json:"repos"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&repos); err != nil {
		t.Fatal(err)
	}
	if len(repos.Repos) != 1 {
		t.Fatalf("got %d repos, want 1", len(repos.Repos))
	}
	r0 := repos.Repos[0]
	if r0.FullName != "acme/net-config" || r0.Owner != "acme" || !r0.Private || r0.DefaultBranch != "main" {
		t.Fatalf("mapped repo = %+v", r0)
	}

	rec = httptest.NewRecorder()
	h.githubBranches(rec, httptest.NewRequest(http.MethodGet, "/api/github/branches?repo=acme/net-config", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("branches: HTTP %d: %s", rec.Code, rec.Body)
	}
	var br struct {
		Default  string   `json:"default"`
		Branches []string `json:"branches"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&br); err != nil {
		t.Fatal(err)
	}
	if br.Default != "main" || len(br.Branches) != 2 || br.Branches[1] != "release/v24" {
		t.Fatalf("branches = %+v", br)
	}

	// A malformed repo parameter is the caller's mistake, said plainly.
	rec = httptest.NewRecorder()
	h.githubBranches(rec, httptest.NewRequest(http.MethodGet, "/api/github/branches?repo=oops", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad repo param: HTTP %d, want 400", rec.Code)
	}
}
