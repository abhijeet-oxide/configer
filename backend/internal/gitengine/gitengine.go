// Package gitengine wraps the git CLI for the operations Configer needs:
// opening (or bootstrapping) the managed repository, creating an isolated
// worktree per change request, committing with proper identity + attribution,
// pushing, and merging. Shelling out to git keeps behavior identical to what
// users see on the command line and avoids partial reimplementations.
package gitengine

import (
	"context"
	"fmt"
	"log/slog"
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

// git runs one git command in dir. Every git invocation in Configer funnels
// through here, so the flags below apply everywhere by construction.
//
// safe.directory is the one that needs explaining. Git refuses to operate on a
// repository owned by a different user ("detected dubious ownership"), which is
// the normal case in a container: the image runs unprivileged while the mounted
// working tree carries the host user's ownership. The protection exists so you
// do not accidentally execute config or hooks from someone else's checkout -
// but this repository is not "someone else's": an operator mounted it and named
// it as the one to manage. Declaring exactly that path trusted is the narrow
// way to say so. The alternatives are worse: `chown -R` rewrites the user's own
// files to a magic uid, and a global `safe.directory=*` trusts every repository
// on the machine rather than the one we were pointed at.
func (r *Repo) git(dir string, args ...string) (string, error) {
	return r.gitCtx(context.Background(), dir, args...)
}

// gitCtx is git with a deadline. Anything that talks to a remote needs one: a
// connection that is accepted and then goes quiet leaves git waiting with no
// limit of its own, and the caller waiting on git. Killing the process is the
// only way to end that, so the context has to reach the command.
func (r *Repo) gitCtx(ctx context.Context, dir string, args ...string) (string, error) {
	full := append([]string{
		"-c", "user.name=" + r.Name,
		"-c", "user.email=" + r.Email,
		"-c", "safe.directory=" + dir,
	}, args...)
	// A worktree's operations run from the worktree directory but resolve
	// through the primary repository, so both ends have to be trusted.
	if r.Dir != "" && r.Dir != dir {
		full = append([]string{"-c", "safe.directory=" + r.Dir}, full...)
	}
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		if ctx.Err() != nil {
			// The process was killed because time ran out, so whatever git
			// managed to print is not the reason - the reason is that it never
			// finished. Say that, or the caller reports a truncated transfer as
			// if the repository were at fault.
			return "", fmt.Errorf("git %s: %w", strings.Join(args, " "), ctx.Err())
		}
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
	return CloneContext(context.Background(), url, dir, branch, token, name, email)
}

// CloneContext is Clone with a deadline, plus git's own stall detector: a
// transfer that drops under a trickle for a minute is abandoned rather than
// held open forever. The two cover different failures - a connection that goes
// quiet mid-transfer, and one that never really starts - and without either, a
// repository that cannot be fetched shows "Connecting" for as long as the
// server stays up.
func CloneContext(ctx context.Context, url, dir, branch, token, name, email string) (*Repo, error) {
	dir = abs(dir)
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return nil, err
	}
	r := &Repo{Dir: dir, Name: name, Email: email}
	run := func(partial bool) error {
		args := []string{
			"-c", "http.lowSpeedLimit=1000",
			"-c", "http.lowSpeedTime=60",
			"clone",
		}
		if partial {
			args = append(args, "--filter=blob:none")
		}
		if branch != "" {
			args = append(args, "--branch", branch)
		}
		args = append(args, AuthURL(url, token), dir)
		_, err := r.gitCtx(ctx, filepath.Dir(dir), args...)
		return err
	}

	err := run(partialClone())
	if err != nil && partialClone() {
		// The host may not offer partial clone (an old self-hosted server, a
		// mirror, a plain http remote). Modern git degrades on its own with a
		// warning, but not every version and not every server does, so a second
		// attempt without the filter is the difference between "your repository
		// could not be fetched" and it simply working.
		slog.Info("partial clone was refused; fetching the whole repository instead",
			slog.String("origin", Redact(url)))
		_ = os.RemoveAll(dir)
		err = run(false)
	}
	if err != nil {
		msg := err.Error()
		if token != "" {
			// never leak the credential through the git error text
			msg = strings.ReplaceAll(msg, token, "***")
		}
		return nil, fmt.Errorf("clone %s: %s", Redact(url), msg)
	}
	return r, nil
}

// partialClone reports whether clones ask the host to withhold file contents
// until something reads them (`--filter=blob:none`).
//
// This is a PARTIAL clone, and deliberately not a shallow one. Shallow
// (`--depth`) would be the obvious way to make a clone smaller and it is the
// wrong tool here twice over: it fetches a single branch, so comparing against
// another branch has nothing to compare with, and it fetches a single commit,
// so history, the timeline, parameter history and restoring from a ref all stop
// working. Those are not edge features of Configer, they are most of what it
// is for.
//
// A partial clone keeps every commit, every tree and every branch. Only file
// CONTENT is left on the server, and git fetches a blob transparently the first
// time anything reads it. So the whole product still works; the price is that
// reading old content needs the host to be reachable, and the first read of it
// is slower.
//
// CONFIGER_FULL_CLONE=1 turns it off, for a deployment that would rather pay
// the download once and never depend on the network again.
func partialClone() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("CONFIGER_FULL_CLONE"))) {
	case "1", "true", "yes", "on":
		return false
	}
	return true
}

// IsRepo reports whether dir holds git repository data at all. A copy Configer
// made itself always should; one that does not means the copy failed rather
// than that anything is wrong with the repository it came from.
func IsRepo(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}

// HasCommits reports whether a repository has any history yet. A repository
// created and never pushed to clones successfully and looks like a working
// tree, but there is nothing in it to read, nothing to branch from and nothing
// to write back against.
func HasCommits(dir string) bool {
	r := &Repo{Dir: dir}
	_, err := r.git(dir, "rev-parse", "--verify", "HEAD")
	return err == nil
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
	credRe    = regexp.MustCompile(`^(https?://)[^/@\s]+@`)
	anyCredRe = regexp.MustCompile(`(https?://)[^/@\s]+@`)
	tokenRe   = regexp.MustCompile(`^https?://[^/:@\s]*:([^/@\s]+)@`)
)

// abs makes a filesystem path absolute, leaving it alone if that is not
// possible. Every path Configer hands to git as an ARGUMENT goes through this.
//
// It is not a tidiness measure. These commands run with the working directory
// set to somewhere inside the data directory, and git resolves a relative
// argument against THAT - so a relative destination is applied twice and the
// clone lands somewhere nobody looks, with git reporting success. Configer's
// data directory is "./configer-data" by default, so this was the normal case,
// not an edge one: every repository added to a deployment that had not set an
// absolute CONFIGER_DATA was copied into a folder inside a folder, and the
// application it should have become was empty.
func abs(p string) string {
	if a, err := filepath.Abs(p); err == nil {
		return a
	}
	return p
}

// Redact strips embedded credentials from a remote URL for display.
func Redact(url string) string {
	return credRe.ReplaceAllString(url, "$1")
}

// RedactAll strips embedded credentials from every URL inside a block of free
// text. Redact anchors at the start because it is given one URL; git's own
// error output quotes URLs mid-sentence, and a credential is no less exposed
// for being in the middle of one.
func RedactAll(text string) string {
	return anyCredRe.ReplaceAllString(text, "$1")
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

// RefExists reports whether a branch name is already taken, locally or on the
// origin. Both matter when naming a new branch: a local one blocks creating it,
// and a remote one turns the eventual push into a rejected non-fast-forward,
// which is the failure a user can do least about.
func (r *Repo) RefExists(branch string) bool {
	for _, ref := range []string{"refs/heads/" + branch, "refs/remotes/origin/" + branch} {
		if _, err := r.git(r.Dir, "rev-parse", "--verify", "--quiet", ref); err == nil {
			return true
		}
	}
	return false
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
	path = abs(path)
	// Clean up any stale state from an earlier crash of the same CR.
	_, _ = r.git(r.Dir, "worktree", "remove", "--force", path)
	_, _ = r.git(r.Dir, "worktree", "prune")
	_, _ = r.git(r.Dir, "branch", "-D", branch)
	_, err := r.git(r.Dir, "worktree", "add", "-b", branch, path, base)
	return err
}

// RemoveWorktree detaches and prunes a change-request worktree.
func (r *Repo) RemoveWorktree(path string) {
	path = abs(path)
	_, _ = r.git(r.Dir, "worktree", "remove", "--force", path)
	_, _ = r.git(r.Dir, "worktree", "prune")
}

// AddWorktreeDetached checks a ref out into path in DETACHED HEAD (no branch),
// for read-only materialization of an arbitrary ref (compare / render at ref).
func (r *Repo) AddWorktreeDetached(path, ref string) error {
	path = abs(path)
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
// with a merge commit (mirroring a PR merge). On any failure (a conflict, most
// commonly) it aborts the merge so the primary tree is never left in a
// half-merged MERGING state that readers of the grid would then see.
func (r *Repo) MergeBranch(branch, message string) error {
	if _, err := r.git(r.Dir, "merge", "--no-ff", "-m", message, branch); err != nil {
		_, _ = r.git(r.Dir, "merge", "--abort") // best effort: restore a clean tree
		return err
	}
	return nil
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

// GitHubFullName extracts "owner/name" from a GitHub remote URL, in either the
// https or the ssh form, with any embedded credential and trailing ".git"
// removed. It reports false for anything that is not a GitHub repository - a
// local folder, or another host - so callers can tell "not GitHub" apart from
// "GitHub, unknown repository".
func GitHubFullName(origin string) (string, bool) {
	u := strings.TrimSpace(Redact(origin))
	switch {
	case strings.HasPrefix(u, "git@"):
		// git@github.com:owner/name.git
		host, path, ok := strings.Cut(strings.TrimPrefix(u, "git@"), ":")
		if !ok || !isGitHubHost(host) {
			return "", false
		}
		u = path
	case strings.Contains(u, "://"):
		_, rest, _ := strings.Cut(u, "://")
		host, path, ok := strings.Cut(rest, "/")
		if !ok || !isGitHubHost(host) {
			return "", false
		}
		u = path
	default:
		return "", false // a local path
	}
	u = strings.TrimSuffix(strings.Trim(u, "/"), ".git")
	owner, name, ok := strings.Cut(u, "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") {
		return "", false
	}
	return owner + "/" + name, true
}

// isGitHubHost matches github.com and GitHub Enterprise hosts, which is as far
// as a URL can tell us; a non-GitHub host simply has no permissions API here.
func isGitHubHost(host string) bool {
	host = strings.ToLower(host)
	if i := strings.Index(host, "@"); i >= 0 {
		host = host[i+1:]
	}
	host, _, _ = strings.Cut(host, ":")
	return host == "github.com" || strings.HasPrefix(host, "github.") ||
		strings.HasSuffix(host, ".github.com")
}
