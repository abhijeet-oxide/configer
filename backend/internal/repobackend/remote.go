package repobackend

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sync"

	"github.com/abhijeet-oxide/configer/backend/internal/provider"
	"github.com/abhijeet-oxide/configer/backend/internal/remoterepo"
)

// RemoteBackend manages a repository purely through the GitHub Git data API.
// RootDir is a materialized cache (plain files, NO .git) that the read engine
// reads; every Git write is a partial commit through remoterepo, and sync is
// a compare-driven partial refresh. Nothing is cloned.
type RemoteBackend struct {
	client *remoterepo.Client
	root   string // the read cache
	branch string // default working branch
	prov   provider.Provider

	mu       sync.Mutex
	baseSHA  string            // commit the cache currently reflects
	baseline map[string][sha256.Size]byte // path -> content hash at baseSHA
}

// NewRemote materializes the branch into rootDir (created) and returns a
// backend serving from that cache.
func NewRemote(ctx context.Context, client *remoterepo.Client, branch, rootDir string, prov provider.Provider) (*RemoteBackend, error) {
	if branch == "" {
		def, err := client.DefaultBranch(ctx)
		if err != nil {
			return nil, err
		}
		branch = def
	}
	if err := os.MkdirAll(rootDir, 0o755); err != nil {
		return nil, err
	}
	sha, err := client.Materialize(ctx, branch, rootDir)
	if err != nil {
		return nil, err
	}
	b := &RemoteBackend{client: client, root: rootDir, branch: branch, prov: prov, baseSHA: sha}
	b.baseline, _ = hashTree(rootDir)
	return b, nil
}

func (b *RemoteBackend) Kind() string               { return "remote" }
func (b *RemoteBackend) RootDir() string            { return b.root }
func (b *RemoteBackend) Origin() string             { return b.client.Origin() }
func (b *RemoteBackend) CanPublish() bool            { return true }
func (b *RemoteBackend) Provider() provider.Provider { return b.prov }

func (b *RemoteBackend) DefaultBranch(_ context.Context) (string, error) { return b.branch, nil }

func (b *RemoteBackend) HeadSHA(ctx context.Context, ref string) (string, error) {
	if ref == "HEAD" {
		ref = b.branch
	}
	return b.client.HeadSHA(ctx, ref)
}

func (b *RemoteBackend) DeleteBranch(ctx context.Context, branch string) {
	b.client.DeleteBranch(ctx, branch)
}

func (b *RemoteBackend) MaterializeRef(ctx context.Context, ref, dir string) (func(), error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if _, err := b.client.Materialize(ctx, ref, dir); err != nil {
		return nil, err
	}
	return func() { _ = os.RemoveAll(dir) }, nil
}

// ListRefs degrades to the default branch for remote repos (a GitHub list-refs
// call is a small fast-follow); MaterializeRef still works for any ref name.
func (b *RemoteBackend) ListRefs(_ context.Context) ([]string, []string, error) {
	return []string{b.branch}, nil, nil
}

// Log degrades to an empty history for remote repos (a GitHub commits-API
// fast-follow); the History views render an informative empty state instead.
func (b *RemoteBackend) Log(_ context.Context, _ string, _ int) ([]Commit, error) {
	return nil, nil
}

// remoteWorkspace is a materialized checkout of a base branch in a temp dir,
// with the file hashes captured at checkout so Commit can compute the exact
// changed + deleted paths for a single Git-data-API partial commit.
type remoteWorkspace struct {
	client   *remoterepo.Client
	dir      string
	branch   string
	baseSHA  string
	baseline map[string][sha256.Size]byte
}

func (w *remoteWorkspace) Dir() string { return w.dir }

func (w *remoteWorkspace) Commit(ctx context.Context, message string) (string, error) {
	changed, deletes, err := diffAgainst(w.dir, w.baseline)
	if err != nil {
		return "", err
	}
	if len(changed) == 0 && len(deletes) == 0 {
		return "", fmt.Errorf("no changes to commit")
	}
	return w.client.CommitPaths(ctx, w.branch, w.baseSHA, message, w.dir, changed, deletes)
}

func (w *remoteWorkspace) Close() { _ = os.RemoveAll(w.dir) }

func (b *RemoteBackend) OpenCR(ctx context.Context, branch, base string) (Workspace, error) {
	dir, err := os.MkdirTemp("", "configer-cr-remote-")
	if err != nil {
		return nil, err
	}
	baseSHA, err := b.client.Materialize(ctx, base, dir)
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	baseline, err := hashTree(dir)
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	return &remoteWorkspace{client: b.client, dir: dir, branch: branch, baseSHA: baseSHA, baseline: baseline}, nil
}

func (b *RemoteBackend) MergeBranch(ctx context.Context, target, crBranch, message string) error {
	if _, err := b.client.Merge(ctx, target, crBranch, message); err != nil {
		return err
	}
	_, err := b.Sync(ctx, target)
	return err
}

func (b *RemoteBackend) CommitWorking(ctx context.Context, message string) (string, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	changed, deletes, err := diffAgainst(b.root, b.baseline)
	if err != nil {
		return "", false, err
	}
	if len(changed) == 0 && len(deletes) == 0 {
		return "", false, nil
	}
	sha, err := b.client.CommitPaths(ctx, b.branch, b.baseSHA, message, b.root, changed, deletes)
	if err != nil {
		return "", false, err
	}
	// The cache now reflects the new commit.
	b.baseSHA = sha
	b.baseline, _ = hashTree(b.root)
	return sha, true, nil
}

func (b *RemoteBackend) Diff(ctx context.Context, from, to string) ([]FileChange, error) {
	files, err := b.client.Compare(ctx, from, to)
	if err != nil {
		return nil, err
	}
	statusMap := map[string]string{"added": "A", "modified": "M", "removed": "D", "renamed": "R"}
	out := make([]FileChange, 0, len(files))
	for _, f := range files {
		out = append(out, FileChange{Status: statusMap[f.Status], Path: f.Path, OldPath: f.OldPath})
	}
	return out, nil
}

// Sync refreshes the cache to the branch head via the compare API (only
// changed paths are fetched), then re-baselines.
func (b *RemoteBackend) Sync(ctx context.Context, branch string) (SyncStatus, error) {
	if branch == "" {
		branch = b.branch
	}
	st := SyncStatus{Branch: branch, Remote: b.client.Origin()}
	b.mu.Lock()
	defer b.mu.Unlock()
	head, err := b.client.HeadSHA(ctx, branch)
	if err != nil {
		st.SyncError = err.Error()
		return st, nil
	}
	if head == b.baseSHA {
		return st, nil
	}
	newSHA, err := b.client.Refresh(ctx, branch, b.baseSHA, b.root)
	if err != nil {
		st.SyncError = err.Error()
		return st, nil
	}
	log.Printf("synced remote cache to %s (%s)", branch, newSHA[:min(7, len(newSHA))])
	b.baseSHA = newSHA
	b.baseline, _ = hashTree(b.root)
	return st, nil
}

// hashTree records the sha256 of every file under root (relative slash paths).
// The .git directory never exists here, but skip it defensively.
func hashTree(root string) (map[string][sha256.Size]byte, error) {
	out := map[string][sha256.Size]byte{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		content, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		rel, _ := filepath.Rel(root, path)
		out[filepath.ToSlash(rel)] = sha256.Sum256(content)
		return nil
	})
	return out, err
}

// diffAgainst compares the current files under dir with a hash baseline and
// returns changed/new paths and deleted paths (both relative slash paths).
func diffAgainst(dir string, baseline map[string][sha256.Size]byte) (changed, deletes []string, err error) {
	present := map[string]bool{}
	err = filepath.WalkDir(dir, func(path string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return werr
		}
		if d.IsDir() {
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		content, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		rel, _ := filepath.Rel(dir, path)
		slash := filepath.ToSlash(rel)
		present[slash] = true
		if old, ok := baseline[slash]; !ok || old != sha256.Sum256(content) {
			changed = append(changed, slash)
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	for p := range baseline {
		if !present[p] {
			deletes = append(deletes, p)
		}
	}
	return changed, deletes, nil
}
