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
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, h.auth.GitHubAPIBase()+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := ghHTTP.Do(req)
	if err != nil {
		return fmt.Errorf("GitHub is not reachable right now: %w", err)
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return fmt.Errorf("GitHub did not accept the sign-in; please sign in again")
	case res.StatusCode == http.StatusNotFound:
		return fmt.Errorf("that repository was not found, or the sign-in has no access to it")
	case res.StatusCode != http.StatusOK:
		return fmt.Errorf("GitHub answered with HTTP %d", res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(out)
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
	// Three pages of 100 cover the overwhelming majority of accounts; the
	// picker has a search box for the rest.
	for page := 1; page <= 3; page++ {
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
	}
	writeJSON(w, http.StatusOK, map[string]any{"repos": out})
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
