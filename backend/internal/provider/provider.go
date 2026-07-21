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

	"github.com/abhijeet-oxide/configer/backend/internal/httpx"
)

// PR is the provider-neutral view of a pull request.
type PR struct {
	Number int    `json:"number"`
	URL    string `json:"url"`
	State  string `json:"state"` // open | closed
	Merged bool   `json:"merged"`
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
		HTTP: httpx.Client(30 * time.Second)}
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
		Number  int    `json:"number"`
		HTMLURL string `json:"html_url"`
		State   string `json:"state"`
		Merged  bool   `json:"merged"`
	}
	err := g.do(ctx, "GET", fmt.Sprintf("/repos/%s/%s/pulls/%d", g.Owner, g.Repo, number), nil, &res)
	return PR{Number: res.Number, URL: res.HTMLURL, State: res.State, Merged: res.Merged}, err
}
