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
	"github.com/abhijeet-oxide/configer/backend/internal/store"
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

// signedIn builds a request carrying an authenticated user, so a handler behind
// requireUser can be exercised without a session store.
func signedIn(method, path string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	return r.WithContext(auth.WithUser(r.Context(), store.User{Login: "vera"}))
}

// Organizations are listed so the picker can name one it can see nothing in.
// A session granted before read:org was asked for stays valid but cannot list
// them: that is a reconnect prompt, not an error page - and not silence, which
// would leave the feature permanently off for everyone who was already signed
// in when the scope changed.
func TestGitHubOrgsAsksForReconnectOnAnOldGrant(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"the call is refused", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-OAuth-Scopes", "read:user, user:email, repo")
			w.WriteHeader(http.StatusForbidden)
		}},
		{"it answers but the scope is absent", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-OAuth-Scopes", "read:user, user:email, repo")
			fmt.Fprint(w, `[]`)
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			gh := httptest.NewServer(c.handler)
			defer gh.Close()
			t.Setenv("CONFIGER_GITHUB_TOKEN", "server-token")
			h := &Hub{auth: &auth.Service{
				ClientID: "cid", ClientSecret: "sec", APIBase: gh.URL, Store: &store.Store{},
			}}

			rec := httptest.NewRecorder()
			h.githubOrgs(rec, signedIn(http.MethodGet, "/api/github/orgs"))
			if rec.Code != http.StatusOK {
				t.Fatalf("orgs = %d, want 200 so the picker keeps working", rec.Code)
			}
			var got struct {
				Orgs        []GitHubOrg `json:"orgs"`
				GrantURL    string      `json:"grantUrl"`
				NeedsReauth bool        `json:"needsReauth"`
			}
			if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
				t.Fatal(err)
			}
			if len(got.Orgs) != 0 {
				t.Errorf("orgs = %+v, want empty", got.Orgs)
			}
			if !got.NeedsReauth {
				t.Error("a grant without read:org must ask the user to reconnect")
			}
			if !strings.HasSuffix(got.GrantURL, "/settings/connections/applications/cid") {
				t.Errorf("grantUrl = %q, want the OAuth app's connection page", got.GrantURL)
			}
		})
	}
}

// A current grant carries read:org, so nothing is asked of the user.
func TestGitHubOrgsIsQuietOnACurrentGrant(t *testing.T) {
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-OAuth-Scopes", "read:user, user:email, repo, read:org")
		fmt.Fprint(w, `[{"login":"acme"}]`)
	}))
	defer gh.Close()
	t.Setenv("CONFIGER_GITHUB_TOKEN", "server-token")
	h := &Hub{auth: &auth.Service{
		ClientID: "cid", ClientSecret: "sec", APIBase: gh.URL, Store: &store.Store{},
	}}
	rec := httptest.NewRecorder()
	h.githubOrgs(rec, signedIn(http.MethodGet, "/api/github/orgs"))
	var got struct {
		Orgs        []GitHubOrg `json:"orgs"`
		NeedsReauth bool        `json:"needsReauth"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Orgs) != 1 || got.Orgs[0].Login != "acme" {
		t.Fatalf("orgs = %+v", got.Orgs)
	}
	if got.NeedsReauth {
		t.Error("a grant that already carries read:org must not ask for anything")
	}
}
