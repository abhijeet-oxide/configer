package api

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// TestTreeCacheReusesParsesUntilTheFileChanges is the whole contract in one
// place: a second read of an unchanged file must not re-parse it, and a read
// after ANY change to it must.
func TestTreeCacheReusesParsesUntilTheFileChanges(t *testing.T) {
	root := twoInstanceRepo(t)
	c := newTreeCache(root)
	docs := c.docsAt(0)

	const file = "instances/staging/values.yaml"
	first := docs.Doc(file, "yaml")
	if first == nil {
		t.Fatal("the file did not parse at all")
	}
	if again := docs.Doc(file, "yaml"); again != first {
		t.Fatal("an unchanged file was parsed a second time")
	}

	// An edit made outside Configer - an operator in the working copy, a
	// developer in the repository `make dev` serves - must be visible at once.
	full := filepath.Join(root, file)
	if err := os.WriteFile(full, []byte("app:\n  port: 7001\n  name: demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Some filesystems carry whole-second modification times; make sure the
	// stamp really differs so the test measures the cache, not the clock.
	touch(t, full)

	edited := docs.Doc(file, "yaml")
	if edited == first {
		t.Fatal("an edited file kept its old parse")
	}
	got, ok, err := edited.Get("$.app.port")
	if err != nil || !ok {
		t.Fatalf("reading the edited file: ok=%v err=%v", ok, err)
	}
	if got != 7001 {
		t.Fatalf("cache served a stale value: got %v, want 7001", got)
	}
}

// TestTreeCacheDropsEverythingOnAWrite covers the case stamps cannot: a one
// character value edit on a filesystem with coarse modification times leaves
// both size and mtime untouched. Releasing the working-tree lock bumps the
// generation, and a new generation discards the cache outright.
func TestTreeCacheDropsEverythingOnAWrite(t *testing.T) {
	root := twoInstanceRepo(t)
	c := newTreeCache(root)

	const file = "instances/staging/values.yaml"
	first := c.docsAt(0).Doc(file, "yaml")
	if same := c.docsAt(0).Doc(file, "yaml"); same != first {
		t.Fatal("same generation should reuse the parse")
	}
	if next := c.docsAt(1).Doc(file, "yaml"); next == first {
		t.Fatal("a new write generation must discard the cached parse")
	}
}

// TestTreeCacheIsNotThrashedByAStragglingReader: a request that began before a
// write carries the older generation and keeps asking for files while newer
// requests are served. If both generations reset the cache, they clear each
// other's work on every lookup and it holds nothing at all for as long as they
// overlap. Only a forward step may discard.
func TestTreeCacheIsNotThrashedByAStragglingReader(t *testing.T) {
	root := twoInstanceRepo(t)
	c := newTreeCache(root)
	const file = "instances/staging/values.yaml"

	current := c.docsAt(5)
	straggler := c.docsAt(4) // began before the write that produced generation 5

	warm := current.Doc(file, "yaml")
	if got := straggler.Doc(file, "yaml"); got != warm {
		t.Fatal("the older request discarded the newer cache")
	}
	if got := current.Doc(file, "yaml"); got != warm {
		t.Fatal("the newer request had to re-parse after the older one ran")
	}

	// A genuine write still invalidates.
	if got := c.docsAt(6).Doc(file, "yaml"); got == warm {
		t.Fatal("a forward generation step must still discard")
	}
}

// The project cache follows the same rule.
func TestProjectCacheIsNotThrashedByAStragglingReader(t *testing.T) {
	root := twoInstanceRepo(t)
	c := newTreeCache(root)

	warm, err := c.Project(5)
	if err != nil {
		t.Fatal(err)
	}
	older, err := c.Project(4)
	if err != nil {
		t.Fatal(err)
	}
	if older != warm {
		t.Fatal("the older request discarded the newer project load")
	}
	again, err := c.Project(5)
	if err != nil {
		t.Fatal(err)
	}
	if again != warm {
		t.Fatal("the newer request had to reload after the older one ran")
	}
	next, err := c.Project(6)
	if err != nil {
		t.Fatal(err)
	}
	if next == warm {
		t.Fatal("a forward generation step must still reload")
	}
}

// TestTreeLockBumpsGenerationOnRelease pins the invalidation mechanism itself:
// it is a property of releasing the lock, so no write path has to remember to
// invalidate anything.
func TestTreeLockBumpsGenerationOnRelease(t *testing.T) {
	var l treeLock
	start := l.Gen()
	l.Lock()
	if l.Gen() != start {
		t.Fatal("taking the lock should not count as a write")
	}
	l.Unlock()
	if l.Gen() == start {
		t.Fatal("releasing the lock must bump the generation")
	}
}

// TestProjectCacheFollowsConfigerFiles: metadata changes are picked up the same
// way, by stamping the .configer files project.Load reads.
func TestProjectCacheFollowsConfigerFiles(t *testing.T) {
	root := twoInstanceRepo(t)
	c := newTreeCache(root)

	p1, err := c.Project(0)
	if err != nil {
		t.Fatal(err)
	}
	p2, err := c.Project(0)
	if err != nil {
		t.Fatal(err)
	}
	if p1 != p2 {
		t.Fatal("an unchanged .configer was loaded twice")
	}

	reg := filepath.Join(root, ".configer", "instances.yaml")
	body, err := os.ReadFile(reg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(reg, append(body, []byte("  - { name: dr, folder: instances/dr }\n")...), 0o644); err != nil {
		t.Fatal(err)
	}
	touch(t, reg)

	p3, err := c.Project(0)
	if err != nil {
		t.Fatal(err)
	}
	if p3 == p1 {
		t.Fatal("an edited .configer kept its old load")
	}
	if _, ok := p3.InstanceByName("dr"); !ok {
		t.Fatal("the newly registered instance is missing from the reloaded project")
	}
}

// TestTreeCacheIsConcurrentlyReadable exercises the per-entry locking: many
// readers of the same and of different files at once, under -race.
func TestTreeCacheIsConcurrentlyReadable(t *testing.T) {
	root := twoInstanceRepo(t)
	c := newTreeCache(root)
	files := []string{"instances/staging/values.yaml", "instances/prod/values.yaml"}

	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			docs := c.docsAt(uint64(i % 3))
			for _, f := range files {
				if d := docs.Doc(f, "yaml"); d == nil {
					t.Errorf("%s did not parse", f)
				}
			}
			if _, err := c.Project(uint64(i % 3)); err != nil {
				t.Errorf("project load: %v", err)
			}
		}(i)
	}
	wg.Wait()
}

// touch forces a file's modification time forward, so a test does not depend on
// the filesystem's timestamp resolution.
func touch(t *testing.T, path string) {
	t.Helper()
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(path, future, future); err != nil {
		t.Fatal(err)
	}
}
