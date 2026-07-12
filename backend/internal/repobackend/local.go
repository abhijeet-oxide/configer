package repobackend

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/gitengine"
	"github.com/abhijeet-oxide/configer/backend/internal/provider"
)

// LocalBackend manages a real git working tree via the git CLI. It is a thin,
// behavior-preserving wrapper over gitengine so existing deployments are
// unaffected by the introduction of the backend seam.
type LocalBackend struct {
	repo *gitengine.Repo
	prov provider.Provider
}

// NewLocal wraps an opened gitengine repository.
func NewLocal(repo *gitengine.Repo, prov provider.Provider) *LocalBackend {
	return &LocalBackend{repo: repo, prov: prov}
}

func (b *LocalBackend) Kind() string             { return "local" }
func (b *LocalBackend) RootDir() string          { return b.repo.Dir }
func (b *LocalBackend) Origin() string           { return gitengine.Redact(b.repo.OriginURL()) }
func (b *LocalBackend) CanPublish() bool          { return b.repo.HasRemote() }
func (b *LocalBackend) Provider() provider.Provider { return b.prov }

func (b *LocalBackend) DefaultBranch(_ context.Context) (string, error) {
	return b.repo.CurrentBranch()
}

func (b *LocalBackend) HeadSHA(_ context.Context, ref string) (string, error) {
	return b.repo.HeadSHA(ref)
}

func (b *LocalBackend) DeleteBranch(_ context.Context, branch string) {
	b.repo.DeleteBranch(branch)
}

// localWorkspace is a git worktree.
type localWorkspace struct {
	repo   *gitengine.Repo
	dir    string
	branch string
}

func (w *localWorkspace) Dir() string { return w.dir }

func (w *localWorkspace) Commit(_ context.Context, message string) (string, error) {
	sha, err := w.repo.CommitAll(w.dir, message)
	if err != nil {
		return "", err
	}
	if w.repo.HasRemote() {
		if err := w.repo.Push(w.branch); err != nil {
			return "", fmt.Errorf("push %s: %w", w.branch, err)
		}
	}
	return sha, nil
}

func (w *localWorkspace) Close() {
	w.repo.RemoveWorktree(w.dir)
	_ = os.RemoveAll(w.dir)
}

func (b *LocalBackend) OpenCR(_ context.Context, branch, base string) (Workspace, error) {
	dir, err := os.MkdirTemp("", "configer-cr-")
	if err != nil {
		return nil, err
	}
	if err := b.repo.AddWorktree(dir, branch, base); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	return &localWorkspace{repo: b.repo, dir: dir, branch: branch}, nil
}

func (b *LocalBackend) MergeBranch(_ context.Context, target, crBranch, message string) error {
	cur, err := b.repo.CurrentBranch()
	if err != nil {
		return err
	}
	if cur != target {
		return fmt.Errorf("primary tree is on %s, cannot locally merge into %s", cur, target)
	}
	if err := b.repo.MergeBranch(crBranch, message); err != nil {
		return err
	}
	if b.repo.HasRemote() {
		if err := b.repo.Push(target); err != nil {
			return fmt.Errorf("push %s: %w", target, err)
		}
	}
	return nil
}

func (b *LocalBackend) CommitWorking(_ context.Context, message string) (string, bool, error) {
	sha, err := b.repo.CommitAll(b.repo.Dir, message)
	if err != nil {
		if strings.Contains(err.Error(), "nothing to commit") {
			return "", false, nil
		}
		return "", false, err
	}
	if b.repo.HasRemote() {
		branch, _ := b.repo.CurrentBranch()
		if perr := b.repo.Push(branch); perr != nil {
			log.Printf("warn: push working commit: %v", perr)
		}
	}
	return sha, true, nil
}

func (b *LocalBackend) MaterializeRef(_ context.Context, ref, dir string) (func(), error) {
	if err := b.repo.AddWorktreeDetached(dir, ref); err != nil {
		return nil, err
	}
	return func() { b.repo.RemoveWorktree(dir); _ = os.RemoveAll(dir) }, nil
}

func (b *LocalBackend) ListRefs(_ context.Context) ([]string, []string, error) {
	branches, err := b.repo.Branches()
	if err != nil {
		return nil, nil, err
	}
	tags, _ := b.repo.Tags()
	return branches, tags, nil
}

func (b *LocalBackend) Log(_ context.Context, path string, limit int) ([]Commit, error) {
	entries, err := b.repo.Log(path, limit)
	if err != nil {
		return nil, err
	}
	out := make([]Commit, len(entries))
	for i, e := range entries {
		short := e.SHA
		if len(short) > 7 {
			short = short[:7]
		}
		out[i] = Commit{SHA: e.SHA, Short: short, Author: e.Author, Email: e.Email, Date: e.Date, Message: e.Subject}
	}
	return out, nil
}

func (b *LocalBackend) Diff(_ context.Context, from, to string) ([]FileChange, error) {
	fcs, err := b.repo.DiffNameStatus(from, to)
	if err != nil {
		return nil, err
	}
	out := make([]FileChange, len(fcs))
	for i, f := range fcs {
		out[i] = FileChange{Status: f.Status, Path: f.Path, OldPath: f.OldPath}
	}
	return out, nil
}

// Sync mirrors the original sync loop: fetch, fast-forward when strictly
// behind, report ahead/behind and upstream state.
func (b *LocalBackend) Sync(_ context.Context, branch string) (SyncStatus, error) {
	st := SyncStatus{Branch: branch, Remote: gitengine.Redact(b.repo.OriginURL())}
	if !b.repo.HasRemote() {
		return st, nil
	}
	if err := b.repo.Fetch(); err != nil {
		st.SyncError = err.Error()
		return st, nil
	}
	if b.repo.UpstreamGone(branch) {
		st.UpstreamGone = true
		return st, nil
	}
	ahead, behind, err := b.repo.AheadBehind(branch)
	if err != nil {
		st.SyncError = err.Error()
		return st, nil
	}
	st.Ahead, st.Behind = ahead, behind
	if behind > 0 && ahead == 0 {
		if err := b.repo.Pull(branch); err != nil {
			st.SyncError = err.Error()
		} else {
			log.Printf("synced %d external commit(s) from origin/%s", behind, branch)
			st.Behind = 0
		}
	}
	return st, nil
}
