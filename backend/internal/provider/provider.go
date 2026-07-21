// Package provider abstracts the pull-request host behind a small interface.
// The GitHub implementation ships first (per the design); GitLab/Bitbucket
// slot in later. When no provider applies (local repo, no token), Configer
// falls back to pure-git behavior: branches and merges without a hosted PR.
package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// PR is the provider-neutral view of a pull request.
type PR struct {
	Number int    `json:"number"`
	URL    string `json:"url"`
	State  string `json:"state"` // open | closed
	Merged bool   `json:"merged"`
	// Mergeable is the host's merge-readiness for the PR: for GitHub this is the
	// raw mergeable_state (clean | blocked | dirty | unstable | behind | draft |
	// unknown), passed through so the UI can explain why a merge is or is not
	// possible. Empty when unknown or not applicable.
	Mergeable string `json:"mergeable,omitempty"`
	// Checks is a rolled-up CI status for the PR head commit:
	// passing | failing | pending | none.
	Checks string `json:"checks,omitempty"`
	// HeadSHA is the PR head commit the checks apply to.
	HeadSHA string `json:"headSha,omitempty"`
}

// Provider is the PR-host abstraction.
type Provider interface {
	Name() string
	Create(ctx context.Context, branch, target, title, body string) (PR, error)
	Merge(ctx context.Context, number int, message string) error
	Close(ctx context.Context, number int) error
	Get(ctx context.Context, number int) (PR, error)
}

var githubURLRe = regexp.MustCompile(`github\.com[:/]([^/]+)/([^/\s]+?)(?:\.git)?$`)

// ParseGitHubOrigin extracts owner/repo from https or ssh GitHub remote URLs.
func ParseGitHubOrigin(origin string) (owner, repo string, ok bool) {
	m := githubURLRe.FindStringSubmatch(strings.TrimSpace(origin))
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

// ForOrigin returns a GitHub provider when the origin is a github.com URL and
// a token is available; otherwise nil (pure-git fallback).
func ForOrigin(origin, token string) Provider {
	owner, repo, ok := ParseGitHubOrigin(origin)
	if !ok || token == "" {
		return nil
	}
	return &GitHub{Owner: owner, Repo: repo, Token: token,
		HTTP: &http.Client{Timeout: 30 * time.Second}}
}

// GitHub implements Provider against the GitHub REST API.
type GitHub struct {
	Owner string
	Repo  string
	Token string
	HTTP  *http.Client
	// BaseURL overrides https://api.github.com (for GHE or tests).
	BaseURL string
}

func (g *GitHub) Name() string { return "github" }

func (g *GitHub) base() string {
	if g.BaseURL != "" {
		return g.BaseURL
	}
	return "https://api.github.com"
}

func (g *GitHub) do(ctx context.Context, method, path string, in, out any) error {
	var body *bytes.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	} else {
		body = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, g.base()+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+g.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")
	res, err := g.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		var e struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(res.Body).Decode(&e)
		return fmt.Errorf("github %s %s: %s (%s)", method, path, res.Status, e.Message)
	}
	if out != nil {
		return json.NewDecoder(res.Body).Decode(out)
	}
	return nil
}

func (g *GitHub) Create(ctx context.Context, branch, target, title, body string) (PR, error) {
	var res struct {
		Number  int    `json:"number"`
		HTMLURL string `json:"html_url"`
		State   string `json:"state"`
	}
	err := g.do(ctx, "POST", fmt.Sprintf("/repos/%s/%s/pulls", g.Owner, g.Repo), map[string]string{
		"title": title, "body": body, "head": branch, "base": target,
	}, &res)
	return PR{Number: res.Number, URL: res.HTMLURL, State: res.State}, err
}

func (g *GitHub) Merge(ctx context.Context, number int, message string) error {
	return g.do(ctx, "PUT", fmt.Sprintf("/repos/%s/%s/pulls/%d/merge", g.Owner, g.Repo, number),
		map[string]string{"commit_title": message, "merge_method": "merge"}, nil)
}

func (g *GitHub) Close(ctx context.Context, number int) error {
	return g.do(ctx, "PATCH", fmt.Sprintf("/repos/%s/%s/pulls/%d", g.Owner, g.Repo, number),
		map[string]string{"state": "closed"}, nil)
}

func (g *GitHub) Get(ctx context.Context, number int) (PR, error) {
	var res struct {
		Number         int    `json:"number"`
		HTMLURL        string `json:"html_url"`
		State          string `json:"state"`
		Merged         bool   `json:"merged"`
		MergeableState string `json:"mergeable_state"`
		Head           struct {
			SHA string `json:"sha"`
		} `json:"head"`
	}
	if err := g.do(ctx, "GET", fmt.Sprintf("/repos/%s/%s/pulls/%d", g.Owner, g.Repo, number), nil, &res); err != nil {
		return PR{}, err
	}
	pr := PR{
		Number: res.Number, URL: res.HTMLURL, State: res.State, Merged: res.Merged,
		Mergeable: res.MergeableState, HeadSHA: res.Head.SHA, Checks: "none",
	}
	if res.Head.SHA != "" {
		if checks, err := g.checks(ctx, res.Head.SHA); err == nil {
			pr.Checks = checks
		}
	}
	return pr, nil
}

// checkRun is one CI check reported for a commit (GitHub Actions or any other
// checks app).
type checkRun struct {
	Status     string `json:"status"`     // queued | in_progress | completed
	Conclusion string `json:"conclusion"` // success | failure | neutral | ...
}

// checks rolls up the check-runs for a commit into a single status
// (passing | failing | pending | none).
func (g *GitHub) checks(ctx context.Context, sha string) (string, error) {
	var res struct {
		Total int        `json:"total_count"`
		Runs  []checkRun `json:"check_runs"`
	}
	if err := g.do(ctx, "GET", fmt.Sprintf("/repos/%s/%s/commits/%s/check-runs", g.Owner, g.Repo, sha), nil, &res); err != nil {
		return "none", err
	}
	return rollupChecks(res.Runs), nil
}

// rollupChecks reduces a set of check-runs to one status. A run still running
// counts as pending; a completed run whose conclusion is not a success-like
// value (success/neutral/skipped) counts as failing.
func rollupChecks(runs []checkRun) string {
	if len(runs) == 0 {
		return "none"
	}
	anyPending, anyFail := false, false
	for _, r := range runs {
		if r.Status != "completed" {
			anyPending = true
			continue
		}
		switch r.Conclusion {
		case "success", "neutral", "skipped":
			// success-like
		default:
			anyFail = true
		}
	}
	switch {
	case anyFail:
		return "failing"
	case anyPending:
		return "pending"
	default:
		return "passing"
	}
}
