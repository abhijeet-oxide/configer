// Package repobackend is the seam that lets Configer manage a repository
// either with a local git working tree (LocalBackend, the original engine) or
// entirely through the GitHub Git data API with no clone (RemoteBackend). The
// read engine (project.Load, grid, render, diff) always reads plain files
// under RootDir; only the Git write/sync operations differ between backends.
//
// This is phase R2 of the remote-first architecture: "nothing has to be
// cloned locally; we use Git REST APIs for partial checkouts and partial
// commits." LocalBackend keeps existing single-repo and cloned-repo
// deployments byte-for-byte identical; RemoteBackend adds the no-clone mode.
package repobackend

import (
	"context"

	"github.com/abhijeet-oxide/configer/backend/internal/provider"
)

// Commit is one entry in the repository history (identity + subject).
type Commit struct {
	SHA     string `json:"sha"`
	Short   string `json:"short"`
	Author  string `json:"author"`
	Email   string `json:"email,omitempty"`
	Date    string `json:"date"`
	Message string `json:"message"`
}

// FileChange is one path changed between two commits (reconcile input).
type FileChange struct {
	Status  string // A(dded) M(odified) D(eleted) R(enamed)
	Path    string
	OldPath string
}

// SyncStatus is the result of one sync pass: how the read cache / working
// tree relates to the remote, after any fast-forward or refresh.
type SyncStatus struct {
	Branch       string
	Remote       string
	Ahead        int
	Behind       int
	UpstreamGone bool
	SyncError    string
}

// Workspace is an isolated checkout of a base branch on which a change
// request is built; Commit turns the changes into a commit on the CR branch
// (a worktree commit+push locally, a Git-data-API partial commit remotely).
type Workspace interface {
	Dir() string
	Commit(ctx context.Context, message string) (sha string, err error)
	Close()
}

// Backend abstracts every Git write/sync operation Configer needs.
type Backend interface {
	// Kind is "local" or "remote".
	Kind() string
	// RootDir is the directory the read engine reads (working tree or cache).
	RootDir() string
	// Origin is the redacted remote URL ("" for a pure-local repo).
	Origin() string
	// DefaultBranch is the primary working branch.
	DefaultBranch(ctx context.Context) (string, error)
	// HeadSHA resolves a branch (or "HEAD") to a commit sha.
	HeadSHA(ctx context.Context, ref string) (string, error)
	// CanPublish reports whether merges/PRs to a remote are possible.
	CanPublish() bool
	// Provider is the hosted PR provider (nil for pure-git).
	Provider() provider.Provider

	// OpenCR checks base out into a scratch workspace for building CR branch.
	OpenCR(ctx context.Context, branch, base string) (Workspace, error)
	// MergeBranch publishes crBranch into target without a provider (local
	// no-ff merge, or the remote merges API), then refreshes the read cache.
	MergeBranch(ctx context.Context, target, crBranch, message string) error
	// DeleteBranch removes a branch (best effort).
	DeleteBranch(ctx context.Context, branch string)

	// CommitWorking commits the current RootDir state directly onto the
	// default branch (catalog operations: import, retire, attach, edit).
	// committed is false when there was nothing to commit.
	CommitWorking(ctx context.Context, message string) (sha string, committed bool, err error)

	// Diff lists file-level changes from..to (reconcile).
	Diff(ctx context.Context, from, to string) ([]FileChange, error)

	// MaterializeRef checks a ref (branch/tag/commit) out into dir (which must
	// not exist yet) for read-only project loading (compare / render at a ref).
	// The returned cleanup removes any backend-side materialization state.
	MaterializeRef(ctx context.Context, ref, dir string) (cleanup func(), err error)
	// ListRefs lists selectable branches and tags.
	ListRefs(ctx context.Context) (branches, tags []string, err error)

	// Log returns the most recent commits, newest first, optionally restricted
	// to a repo-relative path. Remote backends may degrade to an empty list.
	Log(ctx context.Context, path string, limit int) ([]Commit, error)

	// Sync brings the read cache / working tree up to date with the remote
	// and reports the resulting status. No-op-safe when there is no remote.
	Sync(ctx context.Context, branch string) (SyncStatus, error)
}
