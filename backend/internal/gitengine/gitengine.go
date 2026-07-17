// Package gitengine wraps the git CLI for the operations Configer needs:
// opening (or bootstrapping) the managed repository, creating an isolated
// worktree per change request, committing with proper identity + attribution,
// pushing, and merging. Shelling out to git keeps behavior identical to what
// users see on the command line and avoids partial reimplementations.
package gitengine

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// Repo is a handle to the primary working tree of the managed repository.
type Repo struct {
	Dir string
	// Name/Email are the committer identity (the "machine account" in
	// service-identity mode); the human author is attributed via the
	// Changed-by trailer in commit messages.
	Name  string
	Email string
}

func (r *Repo) git(dir string, args ...string) (string, error) {
	full := append([]string{"-c", "user.name=" + r.Name, "-c", "user.email=" + r.Email}, args...)
	cmd := exec.Command("git", full...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

// EnsureRepo opens dir as a git repository, initializing one (with an initial
// import commit) when the directory is not yet under version control: a dev
// convenience so any config folder can be pointed at directly.
func EnsureRepo(dir, name, email string) (*Repo, error) {
	r := &Repo{Dir: dir, Name: name, Email: email}
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		return r, nil
	}
	if _, err := r.git(dir, "init", "-b", "main"); err != nil {
		return nil, err
	}
	if _, err := r.git(dir, "add", "-A"); err != nil {
		return nil, err
	}
	if _, err := r.git(dir, "commit", "-m", "Initial import (configer)"); err != nil {
		return nil, err
	}
	return r, nil
}

// Clone clones a remote repository into dir (parents created), optionally
// checking out a specific branch. When a token is given it is injected into
// the https remote URL, so later fetches and pushes on this server-side clone
// keep working against private repositories; use Redact before showing the
// origin URL anywhere.
func Clone(url, dir, branch, token, name, email string) (*Repo, error) {
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return nil, err
	}
	r := &Repo{Dir: dir, Name: name, Email: email}
	args := []string{"clone"}
	if branch != "" {
		args = append(args, "--branch", branch)
	}
	args = append(args, AuthURL(url, token), dir)
	if _, err := r.git(filepath.Dir(dir), args...); err != nil {
		msg := err.Error()
		if token != "" {
			// never leak the credential through the git error text
			msg = strings.ReplaceAll(msg, token, "***")
		}
		return nil, fmt.Errorf("clone %s: %s", Redact(url), msg)
	}
	return r, nil
}

// AuthURL injects a token into an https remote URL ("" token or non-https
// URLs pass through unchanged).
func AuthURL(url, token string) string {
	if token == "" || !strings.HasPrefix(url, "https://") {
		return url
	}
	return "https://x-access-token:" + token + "@" + strings.TrimPrefix(url, "https://")
}

var (
	credRe  = regexp.MustCompile(`^(https?://)[^/@\s]+@`)
	tokenRe = regexp.MustCompile(`^https?://[^/:@\s]*:([^/@\s]+)@`)
)

// Redact strips embedded credentials from a remote URL for display.
func Redact(url string) string {
	return credRe.ReplaceAllString(url, "$1")
}

// TokenFromURL extracts an embedded credential from an https remote URL
// ("" when the URL carries none). Lets a restarted server rediscover the
// PR-provider token from the clone it made earlier.
func TokenFromURL(url string) string {
	m := tokenRe.FindStringSubmatch(url)
	if m == nil {
		return ""
	}
	return m[1]
}

// CurrentBranch returns the branch the primary working tree is on.
func (r *Repo) CurrentBranch() (string, error) {
	return r.git(r.Dir, "rev-parse", "--abbrev-ref", "HEAD")
}

// HeadSHA resolves a ref to a commit SHA.
func (r *Repo) HeadSHA(ref string) (string, error) {
	return r.git(r.Dir, "rev-parse", ref)
}

// HasRemote reports whether an "origin" remote is configured.
func (r *Repo) HasRemote() bool {
	_, err := r.git(r.Dir, "remote", "get-url", "origin")
	return err == nil
}

// OriginURL returns the origin remote URL ("" when absent).
func (r *Repo) OriginURL() string {
	url, err := r.git(r.Dir, "remote", "get-url", "origin")
	if err != nil {
		return ""
	}
	return url
}

// AddWorktree creates an isolated worktree at path on a fresh branch cut from
// base. A leftover branch from a previous failed attempt is replaced.
func (r *Repo) AddWorktree(path, branch, base string) error {
	// Clean up any stale state from an earlier crash of the same CR.
	_, _ = r.git(r.Dir, "worktree", "remove", "--force", path)
	_, _ = r.git(r.Dir, "worktree", "prune")
	_, _ = r.git(r.Dir, "branch", "-D", branch)
	_, err := r.git(r.Dir, "worktree", "add", "-b", branch, path, base)
	return err
}

// RemoveWorktree detaches and prunes a change-request worktree.
func (r *Repo) RemoveWorktree(path string) {
	_, _ = r.git(r.Dir, "worktree", "remove", "--force", path)
	_, _ = r.git(r.Dir, "worktree", "prune")
}

// AddWorktreeDetached checks a ref out into path in DETACHED HEAD (no branch),
// for read-only materialization of an arbitrary ref (compare / render at ref).
func (r *Repo) AddWorktreeDetached(path, ref string) error {
	_, _ = r.git(r.Dir, "worktree", "remove", "--force", path)
	_, _ = r.git(r.Dir, "worktree", "prune")
	_, err := r.git(r.Dir, "worktree", "add", "--detach", path, ref)
	return err
}

// Branches lists local branch names.
func (r *Repo) Branches() ([]string, error) {
	out, err := r.git(r.Dir, "for-each-ref", "--format=%(refname:short)", "refs/heads")
	if err != nil {
		return nil, err
	}
	return nonEmptyLines(out), nil
}

// Tags lists tag names.
func (r *Repo) Tags() ([]string, error) {
	out, err := r.git(r.Dir, "tag", "--list")
	if err != nil {
		return nil, err
	}
	return nonEmptyLines(out), nil
}

// LogEntry is one commit from git log (identity + subject, ISO date).
type LogEntry struct {
	SHA     string
	Author  string
	Email   string
	Date    string // ISO-8601 (author date)
	Subject string
}

// Log returns the most recent commits, optionally restricted to a path
// (relative to the repo). limit <= 0 means no cap. Fields are separated by
// the unit separator (0x1f) so subjects can safely contain any punctuation.
func (r *Repo) Log(path string, limit int) ([]LogEntry, error) {
	args := []string{"log"}
	if limit > 0 {
		args = append(args, fmt.Sprintf("--max-count=%d", limit))
	}
	args = append(args, "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s")
	if path != "" {
		args = append(args, "--", path)
	}
	out, err := r.git(r.Dir, args...)
	if err != nil {
		return nil, err
	}
	var entries []LogEntry
	for _, line := range nonEmptyLines(out) {
		f := strings.Split(line, "\x1f")
		if len(f) < 5 {
			continue
		}
		entries = append(entries, LogEntry{SHA: f[0], Author: f[1], Email: f[2], Date: f[3], Subject: f[4]})
	}
	return entries, nil
}

func nonEmptyLines(s string) []string {
	var out []string
	for _, ln := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(ln); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// CommitAll stages and commits everything in dir (a worktree or the primary
// tree) and returns the new commit SHA.
func (r *Repo) CommitAll(dir, message string) (string, error) {
	return r.CommitAllAs(dir, message, "")
}

// CommitAllAs is CommitAll with an explicit git author ("Name <email>").
// The committer stays the machine identity; an empty author keeps the
// machine identity as author too (the pre-existing behavior).
func (r *Repo) CommitAllAs(dir, message, author string) (string, error) {
	if _, err := r.git(dir, "add", "-A"); err != nil {
		return "", err
	}
	args := []string{"commit", "-m", message}
	if author != "" {
		args = append(args, "--author", author)
	}
	if _, err := r.git(dir, args...); err != nil {
		return "", err
	}
	return r.git(dir, "rev-parse", "HEAD")
}

// Push pushes a branch to origin.
func (r *Repo) Push(branch string) error {
	_, err := r.git(r.Dir, "push", "-u", "origin", branch)
	return err
}

// MergeBranch merges branch into the primary working tree's current branch
// with a merge commit (mirroring a PR merge).
func (r *Repo) MergeBranch(branch, message string) error {
	_, err := r.git(r.Dir, "merge", "--no-ff", "-m", message, branch)
	return err
}

// Pull fast-forwards the primary tree from origin (used after a provider-side
// PR merge so the local truth matches the remote).
func (r *Repo) Pull(branch string) error {
	_, err := r.git(r.Dir, "pull", "--ff-only", "origin", branch)
	return err
}

// DeleteBranch removes a local branch (best effort).
func (r *Repo) DeleteBranch(branch string) {
	_, _ = r.git(r.Dir, "branch", "-D", branch)
}

// Fetch updates remote-tracking refs from origin.
func (r *Repo) Fetch() error {
	_, err := r.git(r.Dir, "fetch", "origin", "--prune")
	return err
}

// FileChange is one entry of a name-status diff between two commits.
type FileChange struct {
	Status  string // A(dded) M(odified) D(eleted) R(enamed)
	Path    string
	OldPath string // set for renames
}

// DiffNameStatus lists file-level changes between two refs.
func (r *Repo) DiffNameStatus(from, to string) ([]FileChange, error) {
	out, err := r.git(r.Dir, "diff", "--name-status", "-M", from+".."+to)
	if err != nil {
		return nil, err
	}
	var changes []FileChange
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 2 {
			continue
		}
		status := parts[0][:1]
		fc := FileChange{Status: status, Path: parts[1]}
		if status == "R" && len(parts) >= 3 {
			fc.OldPath = parts[1]
			fc.Path = parts[2]
		}
		changes = append(changes, fc)
	}
	return changes, nil
}

// UpstreamGone reports whether the branch's origin counterpart no longer
// exists (e.g. the remote branch was deleted). Call after a pruning Fetch.
func (r *Repo) UpstreamGone(branch string) bool {
	if !r.HasRemote() {
		return false
	}
	_, err := r.git(r.Dir, "rev-parse", "--verify", "--quiet", "origin/"+branch)
	return err != nil
}

// AheadBehind reports how many commits branch is ahead of / behind its origin
// counterpart (0,0 when in sync).
func (r *Repo) AheadBehind(branch string) (ahead, behind int, err error) {
	out, err := r.git(r.Dir, "rev-list", "--left-right", "--count", branch+"...origin/"+branch)
	if err != nil {
		return 0, 0, err
	}
	if _, err := fmt.Sscanf(out, "%d\t%d", &ahead, &behind); err != nil {
		// some git versions emit spaces
		if _, err2 := fmt.Sscanf(out, "%d %d", &ahead, &behind); err2 != nil {
			return 0, 0, fmt.Errorf("parse ahead/behind %q: %w", out, err)
		}
	}
	return ahead, behind, nil
}
