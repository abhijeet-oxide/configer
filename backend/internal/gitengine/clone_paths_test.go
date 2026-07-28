package gitengine

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// The bug a whole thread of reports came down to: a clone whose destination is
// RELATIVE. These commands run with the working directory set inside the data
// directory, so git resolved the destination against that too and put the
// repository at <dest>/<dest>. It exits 0, so nothing looked wrong until the
// application turned out to be empty - and Configer's data directory is
// "./configer-data" by default, so this was the ordinary case.
func TestCloneWithARelativeDestinationLandsWhereItWasAsked(t *testing.T) {
	upstream := filepath.Join(t.TempDir(), "upstream.git")
	seed(t, upstream)

	work := t.TempDir()
	t.Chdir(work)

	// Exactly the shape Configer uses: data directory relative to the process.
	dest := filepath.Join("configer-data", "repos", ".incoming-flux-cd-1", "repo")
	if _, err := Clone(upstream, dest, "", "", "t", "t@t"); err != nil {
		t.Fatalf("clone: %v", err)
	}
	if _, err := os.Stat(filepath.Join(work, dest, ".git")); err != nil {
		t.Fatalf("the repository is not where it was asked for: %v", err)
	}
	// And nowhere else: the doubled path must not exist.
	doubled := filepath.Join(work, dest, "configer-data")
	if _, err := os.Stat(doubled); err == nil {
		t.Error("the destination was resolved twice; the copy landed inside itself")
	}
}

// A worktree path is passed to git the same way, from a working directory of
// its own, so it has the same trap.
func TestWorktreeWithARelativePathLandsWhereItWasAsked(t *testing.T) {
	upstream := filepath.Join(t.TempDir(), "upstream.git")
	seed(t, upstream)

	work := t.TempDir()
	t.Chdir(work)
	repo, err := Clone(upstream, "clone", "", "", "t", "t@t")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	if err := repo.AddWorktree(filepath.Join("work", "cr-1"), "feature/x", "HEAD"); err != nil {
		t.Fatalf("worktree: %v", err)
	}
	if _, err := os.Stat(filepath.Join(work, "work", "cr-1", ".git")); err != nil {
		t.Fatalf("the worktree is not where it was asked for: %v", err)
	}
}

// seed makes a bare repository with one commit in it.
func seed(t *testing.T, bare string) {
	t.Helper()
	src := t.TempDir()
	run := func(dir string, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(src, "values.yaml"), []byte("a: 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(src, "init", "-q", "-b", "main")
	run(src, "add", "-A")
	run(src, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed")
	run(src, "clone", "-q", "--bare", src, bare)
}
