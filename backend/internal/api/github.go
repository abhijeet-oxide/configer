package api

// GitHub browsing for the New Application flow: which repositories can the
// current user reach (their own and their orgs'), and which branches does one
// repository have. This is what makes creating an application pick-and-click
// instead of pasting URLs and tokens. Credentials are resolved server-side -
// the signed-in user's OAuth token first, the server-wide token as fallback -
// and never travel to the browser.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/auth"
	"github.com/abhijeet-oxide/configer/backend/internal/httpx"
)

// GitHubRepo is one repository the user can pick from.
type GitHubRepo struct {
	FullName      string `json:"fullName"`
	Owner         string `json:"owner"`
	Name          string `json:"name"`
	Private       bool   `json:"private"`
	Description   string `json:"description,omitempty"`
	DefaultBranch string `json:"defaultBranch,omitempty"`
	PushedAt      string `json:"pushedAt,omitempty"`
	URL           string `json:"url"`
}

// githubCred resolves the GitHub credential for this request: the signed-in
// user's own token when we have one, otherwise the server-wide token
// (CONFIGER_GITHUB_TOKEN or GITHUB_TOKEN).
func (h *Hub) githubCred(r *http.Request) (token, source, login string) {
	if u, ok := auth.UserFrom(r.Context()); ok {
		login = u.Login
		if t := h.auth.GitHubToken(u.Login); t != "" {
			return t, "session", u.Login
		}
	}
	if t := getenv("CONFIGER_GITHUB_TOKEN", os.Getenv("GITHUB_TOKEN")); t != "" {
		return t, "server", login
	}
	return "", "", login
}

var ghHTTP = httpx.Client(20 * time.Second)

// ghGet performs one authenticated GitHub API call and decodes the response.
func (h *Hub) ghGet(r *http.Request, token, path string, out any) error {
	_, err := h.ghGetScopes(r, token, path, out)
	return err
}

// ghGetScopes is ghGet plus the scopes GitHub says this token carries
// (X-OAuth-Scopes, returned on every API call). Changing the scopes Configer
// asks for does NOT upgrade a token that was already granted: the session stays
// valid and simply cannot do the new thing. Reading the header is how a
// too-old grant is recognized and named, instead of quietly behaving as if the
// user had no organizations.
func (h *Hub) ghGetScopes(r *http.Request, token, path string, out any) (scopes string, err error) {
	req, rerr := http.NewRequestWithContext(r.Context(), http.MethodGet, h.auth.GitHubAPIBase()+path, nil)
	if rerr != nil {
		return "", rerr
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	res, derr := ghHTTP.Do(req)
	if derr != nil {
		return "", fmt.Errorf("GitHub is not reachable right now: %w", derr)
	}
	defer res.Body.Close()
	scopes = res.Header.Get("X-OAuth-Scopes")
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return scopes, fmt.Errorf("GitHub did not accept the sign-in; please sign in again")
	case res.StatusCode == http.StatusNotFound:
		return scopes, fmt.Errorf("that repository was not found, or the sign-in has no access to it")
	case res.StatusCode != http.StatusOK:
		return scopes, fmt.Errorf("GitHub answered with HTTP %d", res.StatusCode)
	}
	return scopes, json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(out)
}

// hasScope reports whether a GitHub X-OAuth-Scopes header grants one scope.
func hasScope(header, want string) bool {
	for _, s := range strings.Split(header, ",") {
		if strings.TrimSpace(s) == want {
			return true
		}
	}
	return false
}

// githubStatus reports whether repository browsing is possible right now and
// through which credential, so the UI can offer "Sign in with GitHub" vs. the
// repository picker.
// githubStatus reports whether a GitHub credential is available.
//
// @Summary     GitHub credential status
// @Description Whether a GitHub credential is available to the New Application flow, its source, and the signed-in login. Credentials stay server-side.
// @Tags        Workspace
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Router      /api/github/status [get]
func (h *Hub) githubStatus(w http.ResponseWriter, r *http.Request) {
	token, source, login := h.githubCred(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"available":     token != "",
		"source":        source,
		"login":         login,
		"signInEnabled": h.auth.Enabled(),
	})
}

// githubRepos lists the repositories the resolved credential can reach,
// newest activity first: the user's own, ones they collaborate on, and their
// organizations'.
// githubRepos lists repositories the resolved credential can reach.
//
// @Summary     List GitHub repositories
// @Description Repositories the resolved credential can reach (own, collaborations, org), newest activity first. Backs the New Application picker.
// @Tags        Workspace
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Failure     401 {object} APIError "Not signed in"
// @Failure     502 {object} APIError "GitHub call failed"
// @Security    CookieSession
// @Router      /api/github/repos [get]
func (h *Hub) githubRepos(w http.ResponseWriter, r *http.Request) {
	// A server-wide GITHUB_TOKEN must not let an anonymous caller enumerate
	// repositories on the server's budget when login is enabled.
	if !h.requireUser(w, r) {
		return
	}
	token, _, _ := h.githubCred(r)
	if token == "" {
		writeJSON(w, http.StatusUnauthorized,
			map[string]string{"error": "sign in with GitHub to browse your repositories"})
		return
	}
	type wire struct {
		FullName      string `json:"full_name"`
		Name          string `json:"name"`
		Private       bool   `json:"private"`
		Description   string `json:"description"`
		DefaultBranch string `json:"default_branch"`
		PushedAt      string `json:"pushed_at"`
		HTMLURL       string `json:"html_url"`
		Owner         struct {
			Login string `json:"login"`
		} `json:"owner"`
	}
	out := []GitHubRepo{}
	// Ten pages of 100. The listing is "what you have, most recently pushed
	// first", not an exhaustive index: past this the picker's search asks
	// GitHub directly (see githubSearchRepos), which is the only thing that can
	// reach an account with thousands of repositories. `truncated` is reported
	// so the UI can say the list is a window rather than letting a missing
	// repository read as a repository that does not exist.
	truncated := false
	for page := 1; page <= githubRepoPages; page++ {
		var batch []wire
		path := fmt.Sprintf(
			"/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=%d", page)
		if err := h.ghGet(r, token, path, &batch); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		for _, b := range batch {
			out = append(out, GitHubRepo{
				FullName: b.FullName, Owner: b.Owner.Login, Name: b.Name,
				Private: b.Private, Description: b.Description,
				DefaultBranch: b.DefaultBranch, PushedAt: b.PushedAt, URL: b.HTMLURL,
			})
		}
		if len(batch) < 100 {
			break
		}
		truncated = page == githubRepoPages
	}
	writeJSON(w, http.StatusOK, map[string]any{"repos": out, "truncated": truncated})
}

// githubRepoPages bounds the listing: ten pages of 100 is a generous window for
// a picker while staying a handful of API calls.
const githubRepoPages = 10

// GitHubOrg is one organization the signed-in user belongs to. How many of its
// repositories are visible is counted by the picker against the listing it
// already holds, so this stays one cheap call: an org the user is a member of
// but which contributes no repositories has not approved the OAuth app, and
// that is the one case the picker has to explain rather than show empty.
type GitHubOrg struct {
	Login string `json:"login"`
}

// githubOrgs lists the organizations the signed-in user belongs to, alongside
// how many repositories the picker can currently see in each.
//
// @Summary     List GitHub organizations
// @Description Organizations the signed-in user belongs to, with how many of their repositories this deployment can see. An organization with zero visible repositories has not approved the Configer OAuth app; `grantUrl` is where that is granted.
// @Tags        Workspace
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Failure     401 {object} APIError "Not signed in"
// @Failure     502 {object} APIError "GitHub call failed"
// @Security    CookieSession
// @Router      /api/github/orgs [get]
func (h *Hub) githubOrgs(w http.ResponseWriter, r *http.Request) {
	if !h.requireUser(w, r) {
		return
	}
	token, _, _ := h.githubCred(r)
	if token == "" {
		writeJSON(w, http.StatusUnauthorized,
			map[string]string{"error": "sign in with GitHub to browse your organizations"})
		return
	}
	orgs, scopes, err := h.userOrgs(r, token)
	// A session granted before read:org was asked for stays perfectly valid -
	// GitHub does not upgrade a token because the app now wants more - so it
	// simply cannot list organizations. Saying "reconnect" is the difference
	// between the feature never turning on for existing users and one click;
	// answering 200 with an empty list keeps the picker working meanwhile.
	needsReauth := err != nil || (scopes != "" && !hasScope(scopes, "read:org"))
	if err != nil {
		orgs = []GitHubOrg{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"orgs":        orgs,
		"grantUrl":    h.auth.GitHubGrantURL(),
		"needsReauth": needsReauth && h.auth.Enabled(),
	})
}

// userOrgs reads the signed-in user's organizations (login only), and reports
// the scopes GitHub says the token carries.
func (h *Hub) userOrgs(r *http.Request, token string) ([]GitHubOrg, string, error) {
	var batch []struct {
		Login string `json:"login"`
	}
	scopes, err := h.ghGetScopes(r, token, "/user/orgs?per_page=100", &batch)
	if err != nil {
		return nil, scopes, err
	}
	out := make([]GitHubOrg, 0, len(batch))
	for _, o := range batch {
		out = append(out, GitHubOrg{Login: o.Login})
	}
	return out, scopes, nil
}

// githubSearchRepos searches GitHub itself, scoped to what this user can see.
//
// The picker's box used to filter the fetched page in the browser, so anything
// outside that window answered "nothing matches that search" - truncation
// wearing the face of a missing repository. This asks GitHub, restricted to the
// user's own account and their organizations, so the answer covers everything
// they have rather than everything already downloaded.
//
// @Summary     Search GitHub repositories
// @Description Search the signed-in user's own and organization repositories by name. Scoped server-side to the accounts the user belongs to, so it never searches all of GitHub.
// @Tags        Workspace
// @Produce     json
// @Param       q query string true "Search term (2+ characters)"
// @Success     200 {object} map[string]interface{}
// @Failure     400 {object} APIError "Missing or too-short term"
// @Failure     401 {object} APIError "Not signed in"
// @Failure     502 {object} APIError "GitHub call failed"
// @Security    CookieSession
// @Router      /api/github/repos/search [get]
func (h *Hub) githubSearchRepos(w http.ResponseWriter, r *http.Request) {
	if !h.requireUser(w, r) {
		return
	}
	term := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(term) < 2 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "type at least two characters to search"})
		return
	}
	token, _, login := h.githubCred(r)
	if token == "" {
		writeJSON(w, http.StatusUnauthorized,
			map[string]string{"error": "sign in with GitHub to search your repositories"})
		return
	}
	orgs, _, _ := h.userOrgs(r, token) // best effort: fewer scopes just narrows the search
	owners := make([]string, 0, len(orgs)+1)
	if login != "" {
		owners = append(owners, "user:"+login)
	}
	for _, o := range orgs {
		owners = append(owners, "org:"+o.Login)
	}
	if len(owners) == 0 {
		// Nothing to scope to: searching all of GitHub is not what this box
		// means, so answer honestly rather than surprisingly.
		writeJSON(w, http.StatusOK, map[string]any{"repos": []GitHubRepo{}, "scoped": false})
		return
	}
	query := buildRepoSearchQuery(term, owners)

	var res struct {
		Total int `json:"total_count"`
		Items []struct {
			FullName      string `json:"full_name"`
			Name          string `json:"name"`
			Private       bool   `json:"private"`
			Description   string `json:"description"`
			DefaultBranch string `json:"default_branch"`
			PushedAt      string `json:"pushed_at"`
			HTMLURL       string `json:"html_url"`
			Owner         struct {
				Login string `json:"login"`
			} `json:"owner"`
		} `json:"items"`
	}
	path := "/search/repositories?per_page=50&q=" + url.QueryEscape(query)
	if err := h.ghGet(r, token, path, &res); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	out := make([]GitHubRepo, 0, len(res.Items))
	for _, b := range res.Items {
		out = append(out, GitHubRepo{
			FullName: b.FullName, Owner: b.Owner.Login, Name: b.Name,
			Private: b.Private, Description: b.Description,
			DefaultBranch: b.DefaultBranch, PushedAt: b.PushedAt, URL: b.HTMLURL,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"repos": out, "total": res.Total, "scoped": true})
}

// ghQueryMax is GitHub's limit on a search query string.
const ghQueryMax = 256

// buildRepoSearchQuery assembles "<term> in:name <owner qualifiers>", dropping
// owners that would push it past GitHub's 256-character query limit. Owners are
// taken in order, so the user's own account (added first) always survives.
func buildRepoSearchQuery(term string, owners []string) string {
	q := term + " in:name"
	for _, o := range owners {
		if len(q)+1+len(o) > ghQueryMax {
			break
		}
		q += " " + o
	}
	return q
}

// githubBranches lists the branches of one repository (?repo=owner/name) and
// which one is the default.
// githubBranches lists a repository's branches.
//
// @Summary     List GitHub branches
// @Description The branches of a GitHub repository (and its default branch), for the New Application flow.
// @Tags        Workspace
// @Produce     json
// @Param       repo query string true "owner/name"
// @Success     200 {object} map[string]interface{}
// @Failure     400 {object} APIError "Missing repo"
// @Failure     401 {object} APIError "Not signed in"
// @Failure     502 {object} APIError "GitHub call failed"
// @Security    CookieSession
// @Router      /api/github/branches [get]
func (h *Hub) githubBranches(w http.ResponseWriter, r *http.Request) {
	if !h.requireUser(w, r) {
		return
	}
	full := strings.TrimSpace(r.URL.Query().Get("repo"))
	owner, name, ok := strings.Cut(full, "/")
	if !ok || owner == "" || name == "" {
		writeJSON(w, http.StatusBadRequest,
			map[string]string{"error": "repo must look like owner/name"})
		return
	}
	token, _, _ := h.githubCred(r)
	if token == "" {
		writeJSON(w, http.StatusUnauthorized,
			map[string]string{"error": "sign in with GitHub to browse branches"})
		return
	}
	base := "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name)
	var repo struct {
		DefaultBranch string `json:"default_branch"`
	}
	if err := h.ghGet(r, token, base, &repo); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	branches := []string{}
	for page := 1; page <= 2; page++ {
		var batch []struct {
			Name string `json:"name"`
		}
		if err := h.ghGet(r, token, fmt.Sprintf("%s/branches?per_page=100&page=%d", base, page), &batch); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		for _, b := range batch {
			branches = append(branches, b.Name)
		}
		if len(batch) < 100 {
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"default": repo.DefaultBranch, "branches": branches})
}
