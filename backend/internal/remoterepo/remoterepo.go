// Package remoterepo speaks the GitHub Git data API so Configer can manage a
// repository with NO git clone and NO git binary on the write path: partial
// checkouts via trees+blobs (Materialize/Refresh), partial commits via
// blobs -> tree -> commit -> ref (CommitPaths), branch management via refs,
// and merges via the merges API. This is phase R2 of the remote-first
// architecture; the local working directory becomes a disposable cache the
// existing engine reads, while every Git write happens remotely.
package remoterepo

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/provider"
)

// Client talks to one GitHub repository.
type Client struct {
	Owner string
	Repo  string
	Token string
	HTTP  *http.Client
	// BaseURL overrides https://api.github.com (GHE or tests).
	BaseURL string
	// Committer identity for commits made through the API.
	Name  string
	Email string
}

// New builds a client from a github.com URL ("" token allowed for public
// reads; writes need one).
func New(origin, token, name, email string) (*Client, error) {
	owner, repo, ok := provider.ParseGitHubOrigin(origin)
	if !ok {
		return nil, fmt.Errorf("not a GitHub repository URL: %s", origin)
	}
	return &Client{
		Owner: owner, Repo: repo, Token: token,
		HTTP: &http.Client{Timeout: 60 * time.Second},
		Name: name, Email: email,
	}, nil
}

func (c *Client) base() string {
	if c.BaseURL != "" {
		return c.BaseURL
	}
	return "https://api.github.com"
}

// Origin returns the canonical (credential-free) repository URL for display.
func (c *Client) Origin() string {
	return fmt.Sprintf("https://github.com/%s/%s", c.Owner, c.Repo)
}

func (c *Client) do(ctx context.Context, method, path string, in, out any) error {
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
	req, err := http.NewRequestWithContext(ctx, method, c.base()+path, body)
	if err != nil {
		return err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")
	res, err := c.HTTP.Do(req)
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

func (c *Client) repoPath(p string) string {
	return fmt.Sprintf("/repos/%s/%s%s", c.Owner, c.Repo, p)
}

// DefaultBranch reads the repository's default branch.
func (c *Client) DefaultBranch(ctx context.Context) (string, error) {
	var r struct {
		DefaultBranch string `json:"default_branch"`
	}
	err := c.do(ctx, "GET", c.repoPath(""), nil, &r)
	return r.DefaultBranch, err
}

// HeadSHA resolves a branch to its commit sha.
func (c *Client) HeadSHA(ctx context.Context, branch string) (string, error) {
	var r struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	err := c.do(ctx, "GET", c.repoPath("/git/ref/heads/"+branch), nil, &r)
	return r.Object.SHA, err
}

// CreateBranch points a new branch at sha.
func (c *Client) CreateBranch(ctx context.Context, branch, sha string) error {
	return c.do(ctx, "POST", c.repoPath("/git/refs"), map[string]string{
		"ref": "refs/heads/" + branch, "sha": sha,
	}, nil)
}

// UpdateRef moves a branch to sha.
func (c *Client) UpdateRef(ctx context.Context, branch, sha string, force bool) error {
	return c.do(ctx, "PATCH", c.repoPath("/git/refs/heads/"+branch), map[string]any{
		"sha": sha, "force": force,
	}, nil)
}

// DeleteBranch removes a branch (best effort).
func (c *Client) DeleteBranch(ctx context.Context, branch string) {
	_ = c.do(ctx, "DELETE", c.repoPath("/git/refs/heads/"+branch), nil, nil)
}

// TreeEntry is one path in a git tree.
type TreeEntry struct {
	Path string `json:"path"`
	Mode string `json:"mode"`
	Type string `json:"type"` // blob | tree
	SHA  string `json:"sha"`
}

// Tree lists a commit's full tree (recursive).
func (c *Client) Tree(ctx context.Context, sha string) ([]TreeEntry, error) {
	var r struct {
		Tree      []TreeEntry `json:"tree"`
		Truncated bool        `json:"truncated"`
	}
	if err := c.do(ctx, "GET", c.repoPath("/git/trees/"+sha+"?recursive=1"), nil, &r); err != nil {
		return nil, err
	}
	if r.Truncated {
		return nil, fmt.Errorf("repository tree is too large for the trees API (truncated)")
	}
	return r.Tree, nil
}

// Blob fetches one file's content by blob sha.
func (c *Client) Blob(ctx context.Context, sha string) ([]byte, error) {
	var r struct {
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
	}
	if err := c.do(ctx, "GET", c.repoPath("/git/blobs/"+sha), nil, &r); err != nil {
		return nil, err
	}
	if r.Encoding != "base64" {
		return []byte(r.Content), nil
	}
	return base64.StdEncoding.DecodeString(strings.ReplaceAll(r.Content, "\n", ""))
}

// FileChange is one changed path between two commits.
type FileChange struct {
	Status  string `json:"status"` // added | modified | removed | renamed
	Path    string `json:"filename"`
	OldPath string `json:"previous_filename,omitempty"`
	SHA     string `json:"sha"` // blob sha at head
}

// Compare lists file-level changes base...head.
func (c *Client) Compare(ctx context.Context, base, head string) ([]FileChange, error) {
	var r struct {
		Files []FileChange `json:"files"`
	}
	err := c.do(ctx, "GET", c.repoPath("/compare/"+base+"..."+head), nil, &r)
	return r.Files, err
}

// Merge merges head into base with the merges API; returns the merge commit
// sha ("" when base already contained head).
func (c *Client) Merge(ctx context.Context, base, head, message string) (string, error) {
	var r struct {
		SHA string `json:"sha"`
	}
	err := c.do(ctx, "POST", c.repoPath("/merges"), map[string]string{
		"base": base, "head": head, "commit_message": message,
	}, &r)
	return r.SHA, err
}

// Materialize checks the branch's tree out into dir through the API: the
// partial checkout. Returns the checked-out commit sha. dir is created; stale
// files are not removed (call on a fresh dir, use Refresh afterwards).
func (c *Client) Materialize(ctx context.Context, branch, dir string) (string, error) {
	sha, err := c.HeadSHA(ctx, branch)
	if err != nil {
		return "", err
	}
	entries, err := c.Tree(ctx, sha)
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		if e.Type != "blob" {
			continue
		}
		content, berr := c.Blob(ctx, e.SHA)
		if berr != nil {
			return "", fmt.Errorf("fetch %s: %w", e.Path, berr)
		}
		out := filepath.Join(dir, filepath.FromSlash(e.Path))
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return "", err
		}
		mode := os.FileMode(0o644)
		if e.Mode == "100755" {
			mode = 0o755
		}
		if err := os.WriteFile(out, content, mode); err != nil {
			return "", err
		}
	}
	return sha, nil
}

// Refresh updates dir from fromSHA to the branch head, touching only changed
// paths (the compare API drives the partial update). Returns the new sha
// (== fromSHA when nothing moved).
func (c *Client) Refresh(ctx context.Context, branch, fromSHA, dir string) (string, error) {
	head, err := c.HeadSHA(ctx, branch)
	if err != nil {
		return "", err
	}
	if head == fromSHA {
		return head, nil
	}
	files, err := c.Compare(ctx, fromSHA, head)
	if err != nil {
		return "", err
	}
	for _, f := range files {
		switch f.Status {
		case "removed":
			_ = os.Remove(filepath.Join(dir, filepath.FromSlash(f.Path)))
		case "renamed":
			if f.OldPath != "" {
				_ = os.Remove(filepath.Join(dir, filepath.FromSlash(f.OldPath)))
			}
			fallthrough
		default: // added | modified | renamed(new path)
			content, berr := c.Blob(ctx, f.SHA)
			if berr != nil {
				return "", fmt.Errorf("fetch %s: %w", f.Path, berr)
			}
			out := filepath.Join(dir, filepath.FromSlash(f.Path))
			if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
				return "", err
			}
			if err := os.WriteFile(out, content, 0o644); err != nil {
				return "", err
			}
		}
	}
	return head, nil
}

// CommitPaths makes ONE commit on branch containing the given paths (read
// from dir) and deletions, parented on baseSHA: the partial commit through
// the API, no clone anywhere. The branch is created at baseSHA when it does
// not exist yet. Returns the new commit sha.
func (c *Client) CommitPaths(ctx context.Context, branch, baseSHA, message, dir string, paths, deletes []string) (string, error) {
	type treeReq struct {
		Path    string  `json:"path"`
		Mode    string  `json:"mode"`
		Type    string  `json:"type"`
		SHA     *string `json:"sha"`
		Content string  `json:"content,omitempty"`
	}
	entries := make([]treeReq, 0, len(paths)+len(deletes))
	for _, p := range paths {
		content, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(p)))
		if err != nil {
			return "", fmt.Errorf("read %s: %w", p, err)
		}
		// Create the blob explicitly (handles binary content safely).
		var blob struct {
			SHA string `json:"sha"`
		}
		if err := c.do(ctx, "POST", c.repoPath("/git/blobs"), map[string]string{
			"content": base64.StdEncoding.EncodeToString(content), "encoding": "base64",
		}, &blob); err != nil {
			return "", err
		}
		sha := blob.SHA
		entries = append(entries, treeReq{Path: p, Mode: "100644", Type: "blob", SHA: &sha})
	}
	for _, p := range deletes {
		entries = append(entries, treeReq{Path: p, Mode: "100644", Type: "blob", SHA: nil})
	}

	// base tree = the tree of the base commit
	var baseCommit struct {
		Tree struct {
			SHA string `json:"sha"`
		} `json:"tree"`
	}
	if err := c.do(ctx, "GET", c.repoPath("/git/commits/"+baseSHA), nil, &baseCommit); err != nil {
		return "", err
	}
	var tree struct {
		SHA string `json:"sha"`
	}
	if err := c.do(ctx, "POST", c.repoPath("/git/trees"), map[string]any{
		"base_tree": baseCommit.Tree.SHA, "tree": entries,
	}, &tree); err != nil {
		return "", err
	}
	var commit struct {
		SHA string `json:"sha"`
	}
	if err := c.do(ctx, "POST", c.repoPath("/git/commits"), map[string]any{
		"message": message,
		"tree":    tree.SHA,
		"parents": []string{baseSHA},
		"author":  map[string]string{"name": c.Name, "email": c.Email, "date": time.Now().UTC().Format(time.RFC3339)},
	}, &commit); err != nil {
		return "", err
	}

	// Move (or create) the branch ref to the new commit.
	if _, err := c.HeadSHA(ctx, branch); err != nil {
		if cerr := c.CreateBranch(ctx, branch, commit.SHA); cerr != nil {
			return "", cerr
		}
		return commit.SHA, nil
	}
	if err := c.UpdateRef(ctx, branch, commit.SHA, false); err != nil {
		return "", err
	}
	return commit.SHA, nil
}
