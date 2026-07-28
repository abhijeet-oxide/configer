package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/auth"
)

// The picker's search asks GitHub rather than filtering an already-downloaded
// page, and it is scoped to the accounts the user belongs to - it must never
// search all of GitHub.
func TestGitHubSearchIsScopedToTheUsersAccounts(t *testing.T) {
	var gotQuery string
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/user/orgs":
			fmt.Fprint(w, `[{"login":"acme"},{"login":"globex"}]`)
		case "/search/repositories":
			gotQuery = r.URL.Query().Get("q")
			fmt.Fprint(w, `{"total_count":1,"items":[{"full_name":"globex/deep-config","name":"deep-config",
				"private":true,"default_branch":"main","html_url":"https://github.com/globex/deep-config",
				"owner":{"login":"globex"}}]}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer gh.Close()
	t.Setenv("CONFIGER_GITHUB_TOKEN", "server-token")
	h := stubHub(t, gh.URL)

	rec := httptest.NewRecorder()
	h.githubSearchRepos(rec, httptest.NewRequest(http.MethodGet, "/api/github/repos/search?q=deep", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("search: HTTP %d: %s", rec.Code, rec.Body)
	}
	var got struct {
		Repos  []GitHubRepo `json:"repos"`
		Scoped bool         `json:"scoped"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Repos) != 1 || got.Repos[0].FullName != "globex/deep-config" {
		t.Fatalf("results = %+v", got.Repos)
	}
	if !got.Scoped {
		t.Error("a search restricted to the user's accounts must report itself scoped")
	}
	// The org qualifiers are what keep this off the rest of GitHub.
	for _, want := range []string{"deep", "in:name", "org:acme", "org:globex"} {
		if !strings.Contains(gotQuery, want) {
			t.Errorf("query %q is missing %q", gotQuery, want)
		}
	}
}

// A one-character term is not a search: answering it would ask GitHub for
// everything the user owns on every keystroke.
func TestGitHubSearchRejectsShortTerms(t *testing.T) {
	t.Setenv("CONFIGER_GITHUB_TOKEN", "server-token")
	h := stubHub(t, "http://unused")
	rec := httptest.NewRecorder()
	h.githubSearchRepos(rec, httptest.NewRequest(http.MethodGet, "/api/github/repos/search?q=a", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("one-character search = %d, want 400", rec.Code)
	}
}

// GitHub caps a search query at 256 characters, so a user in many organizations
// must still get a valid query - with their own account kept.
func TestRepoSearchQueryStaysWithinGitHubsLimit(t *testing.T) {
	owners := []string{"user:me"}
	for i := 0; i < 60; i++ {
		owners = append(owners, fmt.Sprintf("org:organisation-with-a-long-name-%02d", i))
	}
	q := buildRepoSearchQuery("network", owners)
	if len(q) > ghQueryMax {
		t.Fatalf("query is %d characters, over GitHub's %d limit", len(q), ghQueryMax)
	}
	if !strings.HasPrefix(q, "network in:name user:me") {
		t.Fatalf("the term and the user's own account must survive truncation: %q", q)
	}
	if _, err := url.Parse("https://x/?q=" + url.QueryEscape(q)); err != nil {
		t.Fatal(err)
	}
}

// Organizations are listed so the picker can name one it can see nothing in.
// A session predating the read:org scope simply loses the hint - it is not an
// error page.
func TestGitHubOrgsDegradesWhenScopeIsMissing(t *testing.T) {
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden) // an older grant without read:org
	}))
	defer gh.Close()
	t.Setenv("CONFIGER_GITHUB_TOKEN", "server-token")
	h := &Hub{auth: &auth.Service{APIBase: gh.URL, ClientID: "cid"}}

	rec := httptest.NewRecorder()
	h.githubOrgs(rec, httptest.NewRequest(http.MethodGet, "/api/github/orgs", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("orgs = %d, want 200 with an empty list", rec.Code)
	}
	var got struct {
		Orgs     []GitHubOrg `json:"orgs"`
		GrantURL string      `json:"grantUrl"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Orgs) != 0 {
		t.Errorf("orgs = %+v, want empty", got.Orgs)
	}
	if !strings.HasSuffix(got.GrantURL, "/settings/connections/applications/cid") {
		t.Errorf("grantUrl = %q, want the OAuth app's connection page", got.GrantURL)
	}
}
