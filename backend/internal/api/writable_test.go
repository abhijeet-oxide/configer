package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Configer edits the repository's own files, so a tree it cannot write to
// cannot be managed. The check has to fail at OPEN time - a repository that
// looks healthy and then refuses the first edit is the worst outcome.
func TestEnsureRepoWritable(t *testing.T) {
	t.Run("writable repository passes and gets its state directory", func(t *testing.T) {
		repo := t.TempDir()
		if err := ensureRepoWritable(repo); err != nil {
			t.Fatalf("ensureRepoWritable: %v", err)
		}
		if st, err := os.Stat(filepath.Join(repo, ".git", "configer")); err != nil || !st.IsDir() {
			t.Fatalf("state directory was not created: %v", err)
		}
	})

	t.Run("leaves no probe files behind", func(t *testing.T) {
		repo := t.TempDir()
		if err := ensureRepoWritable(repo); err != nil {
			t.Fatal(err)
		}
		entries, err := os.ReadDir(filepath.Join(repo, ".git", "configer"))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Fatalf("probe left files behind: %v", entries)
		}
	})

	// The regression that matters: MkdirAll returns nil for a directory that
	// already exists, whatever its permissions, so checking only for its
	// creation passes a state directory left by a previous run under another
	// account - and the failure resurfaces at the first edit instead.
	t.Run("existing but unwritable state directory is rejected", func(t *testing.T) {
		if os.Getuid() == 0 {
			t.Skip("root ignores permission bits")
		}
		repo := t.TempDir()
		stateDir := filepath.Join(repo, ".git", "configer")
		if err := os.MkdirAll(stateDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(stateDir, 0o555); err != nil { // read + execute, no write
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(stateDir, 0o755) })

		err := ensureRepoWritable(repo)
		if err == nil {
			t.Fatal("ensureRepoWritable accepted an unwritable state directory")
		}
		// The message reaches a user next to their application, so it must read
		// as plain words rather than a syscall.
		for _, jargon := range []string{"mkdir", "EACCES", "syscall", ".git"} {
			if strings.Contains(err.Error(), jargon) {
				t.Errorf("error message leaks %q: %s", jargon, err)
			}
		}
	})

	t.Run("read-only repository is rejected", func(t *testing.T) {
		if os.Getuid() == 0 {
			t.Skip("root ignores permission bits")
		}
		repo := t.TempDir()
		if err := os.Chmod(repo, 0o555); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(repo, 0o755) })

		if err := ensureRepoWritable(repo); err == nil {
			t.Fatal("ensureRepoWritable accepted a read-only repository")
		}
	})
}
