// Package impact answers the only question that makes a quality platform
// affordable: given what changed, what actually needs to run? Everything else
// in the platform is a constant factor; this is the one that decides whether a
// pull request costs twenty seconds or twenty minutes.
package impact

import (
	"context"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// Change is one file the diff touched.
type Change struct {
	Path   string // repository-relative, slash-separated
	Status string // A, M, D, R
}

// Deleted reports whether the file is gone, which matters because a linter
// pointed at a deleted path fails in a confusing way.
func (c Change) Deleted() bool { return c.Status == "D" }

// Git is the small slice of git the platform needs. It is an interface so the
// selection logic can be tested without a repository on disk.
type Git interface {
	Run(ctx context.Context, args ...string) (string, error)
}

type cliGit struct{ dir string }

// NewGit returns a Git backed by the git CLI in the given working tree.
func NewGit(dir string) Git { return cliGit{dir: dir} }

func (g cliGit) Run(ctx context.Context, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = g.dir
	out, err := cmd.Output()
	return string(out), err
}

// Diff lists the files that differ between baseRef and the working tree.
//
// The merge base, not the tip, is the honest comparison point: a pull request
// is responsible for what IT changed, not for what landed on the base branch
// while it was open. Asking git for the merge base is what stops a busy trunk
// from spuriously widening every open change's blast radius.
func Diff(ctx context.Context, g Git, baseRef string) ([]Change, string, error) {
	if baseRef == "" {
		// No base given: the uncommitted working tree plus the index is the
		// right answer for a local or pre-commit run.
		out, err := g.Run(ctx, "status", "--porcelain=v1", "--untracked-files=all")
		if err != nil {
			return nil, "", err
		}
		return parseStatus(out), "", nil
	}
	base := baseRef
	if mb, err := g.Run(ctx, "merge-base", baseRef, "HEAD"); err == nil {
		if s := strings.TrimSpace(mb); s != "" {
			base = s
		}
	}
	out, err := g.Run(ctx, "diff", "--name-status", "--find-renames", base+"...HEAD")
	if err != nil {
		// A shallow clone or a missing ref is a normal CI condition, not a
		// crash: fall back to "everything changed", which is correct and only
		// slower.
		return nil, base, err
	}
	changes := parseNameStatus(out)

	// Uncommitted work counts too, so `cq run --base main` on a laptop sees
	// what the developer is actually about to push.
	if st, err := g.Run(ctx, "status", "--porcelain=v1", "--untracked-files=all"); err == nil {
		changes = merge(changes, parseStatus(st))
	}
	return changes, base, nil
}

// StagedFiles is the pre-commit view: exactly what is about to be committed.
func StagedFiles(ctx context.Context, g Git) ([]Change, error) {
	out, err := g.Run(ctx, "diff", "--cached", "--name-status", "--diff-filter=ACMR")
	if err != nil {
		return nil, err
	}
	return parseNameStatus(out), nil
}

// HeadCommit returns the current commit sha, or "" outside a repository.
func HeadCommit(ctx context.Context, g Git) string {
	out, err := g.Run(ctx, "rev-parse", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// CurrentBranch returns the checked-out branch, or "" when detached.
func CurrentBranch(ctx context.Context, g Git) string {
	out, err := g.Run(ctx, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return ""
	}
	if s := strings.TrimSpace(out); s != "HEAD" {
		return s
	}
	return ""
}

func parseNameStatus(out string) []Change {
	var cs []Change
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Split(strings.TrimSpace(line), "\t")
		if len(fields) < 2 || fields[0] == "" {
			continue
		}
		status := fields[0][:1]
		// A rename reports both sides; the new path is the one to analyze.
		p := fields[len(fields)-1]
		cs = append(cs, Change{Path: normalize(p), Status: status})
	}
	return cs
}

func parseStatus(out string) []Change {
	var cs []Change
	for _, line := range strings.Split(out, "\n") {
		if len(line) < 4 {
			continue
		}
		code := strings.TrimSpace(line[:2])
		p := strings.TrimSpace(line[3:])
		if i := strings.Index(p, " -> "); i >= 0 {
			p = p[i+4:]
		}
		p = strings.Trim(p, `"`)
		status := "M"
		switch {
		case strings.HasPrefix(code, "?"):
			status = "A"
		case strings.HasPrefix(code, "A"):
			status = "A"
		case strings.HasPrefix(code, "D"):
			status = "D"
		case strings.HasPrefix(code, "R"):
			status = "R"
		}
		cs = append(cs, Change{Path: normalize(p), Status: status})
	}
	return cs
}

func normalize(p string) string {
	return strings.TrimPrefix(strings.ReplaceAll(strings.TrimSpace(p), "\\", "/"), "./")
}

func merge(a, b []Change) []Change {
	seen := map[string]bool{}
	out := make([]Change, 0, len(a)+len(b))
	for _, c := range append(a, b...) {
		if c.Path == "" || seen[c.Path] {
			continue
		}
		seen[c.Path] = true
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// Paths flattens changes to the live (non-deleted) file paths.
func Paths(cs []Change) []string {
	out := make([]string, 0, len(cs))
	for _, c := range cs {
		if !c.Deleted() {
			out = append(out, c.Path)
		}
	}
	return out
}

// AllPaths flattens every change, deleted files included. Scope classification
// wants this: deleting the last backend file is still a backend change.
func AllPaths(cs []Change) []string {
	out := make([]string, 0, len(cs))
	for _, c := range cs {
		out = append(out, c.Path)
	}
	return out
}
