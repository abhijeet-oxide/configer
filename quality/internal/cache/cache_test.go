package cache

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

func entry(key string) Entry {
	return Entry{
		Key: key, Analyzer: "eslint", DurationMS: 1200,
		Findings: []model.Finding{{Fingerprint: "abc", Title: "a finding"}},
		Metrics:  []model.Metric{{ID: "frontend.lint.errors", Value: 1, Unit: "count"}},
	}
}

// A cache that swallows its own write errors is a cache that can silently do
// nothing forever, and the only symptom is a slow pipeline nobody investigates.
// This one did: Put renamed into a fan-out subdirectory it never created, so
// every write failed and every run reported a cold cache.
func TestPutThenGetRoundTrips(t *testing.T) {
	dir := t.TempDir()
	c := Open(filepath.Join(dir, "cache"), true)

	c.Put(entry("deadbeefcafe0000"))

	got, ok := c.Get("deadbeefcafe0000")
	if !ok {
		t.Fatal("a stored entry must be retrievable; this is the whole feature")
	}
	if len(got.Findings) != 1 || got.Findings[0].Title != "a finding" {
		t.Errorf("the normalized result must survive the round trip, got %+v", got.Findings)
	}
	if len(got.Metrics) != 1 {
		t.Errorf("metrics must survive the round trip, got %d", len(got.Metrics))
	}
	if hits, misses := c.Stats(); hits != 1 || misses != 0 {
		t.Errorf("expected one hit and no misses, got %d and %d", hits, misses)
	}
}

func TestMissIsCountedAndHarmless(t *testing.T) {
	c := Open(filepath.Join(t.TempDir(), "cache"), true)
	if _, ok := c.Get("0000000000000000"); ok {
		t.Error("an empty cache must not answer")
	}
	if hits, misses := c.Stats(); hits != 0 || misses != 1 {
		t.Errorf("expected no hits and one miss, got %d and %d", hits, misses)
	}
}

func TestDisabledCacheNeverAnswers(t *testing.T) {
	c := Open(filepath.Join(t.TempDir(), "cache"), false)
	c.Put(entry("aaaaaaaaaaaaaaaa"))
	if _, ok := c.Get("aaaaaaaaaaaaaaaa"); ok {
		t.Error("--no-cache must mean no cache, in both directions")
	}
}

// The key must change when anything that could change the answer changes, and
// must not change otherwise. Both halves matter: the first prevents a stale
// answer, the second is the entire point of having a cache.
func TestKeyRespondsToEverythingThatMatters(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "a.go")
	if err := os.WriteFile(src, []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	base := KeyInput{
		AnalyzerID: "golangci-lint", ToolVersion: "2.5.0",
		Command: []string{"golangci-lint", "run"}, ConfigDigest: "cfg1",
		Files: []string{"a.go"},
	}
	k0, err := Key(root, base)
	if err != nil {
		t.Fatal(err)
	}

	same, err := Key(root, base)
	if err != nil {
		t.Fatal(err)
	}
	if same != k0 {
		t.Fatal("identical inputs must produce an identical key, or nothing ever hits")
	}

	changes := map[string]func(KeyInput) KeyInput{
		"the tool was upgraded":   func(i KeyInput) KeyInput { i.ToolVersion = "2.6.0"; return i },
		"the command changed":     func(i KeyInput) KeyInput { i.Command = []string{"golangci-lint", "run", "--fast"}; return i },
		"the configuration moved": func(i KeyInput) KeyInput { i.ConfigDigest = "cfg2"; return i },
		"the environment differs": func(i KeyInput) KeyInput { i.Env = map[string]string{"GOFLAGS": "-tags=x"}; return i },
		"the tier differs":        func(i KeyInput) KeyInput { i.Extra = []string{"main"}; return i },
		"a different analyzer":    func(i KeyInput) KeyInput { i.AnalyzerID = "go-vet"; return i },
	}
	for name, mutate := range changes {
		k, err := Key(root, mutate(base))
		if err != nil {
			t.Fatal(err)
		}
		if k == k0 {
			t.Errorf("the key must change when %s", name)
		}
	}

	// And the content of the inputs themselves.
	if err := os.WriteFile(src, []byte("package main // edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	edited, err := Key(root, base)
	if err != nil {
		t.Fatal(err)
	}
	if edited == k0 {
		t.Error("the key must change when a declared input file changes")
	}
}

// Length-prefixing every component is what stops two different inputs colliding
// by concatenation, which is the classic way a hand-rolled cache key returns
// somebody else's answer.
func TestKeyDoesNotCollideByConcatenation(t *testing.T) {
	root := t.TempDir()
	a, err := Key(root, KeyInput{AnalyzerID: "ab", ToolVersion: "c"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := Key(root, KeyInput{AnalyzerID: "a", ToolVersion: "bc"})
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Error(`"ab"+"c" and "a"+"bc" must not produce the same key`)
	}
}

func TestPruneRemovesStaleEntries(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cache")
	c := Open(dir, true)
	c.Put(entry("1111111111111111"))

	if n := c.Prune(time.Hour); n != 0 {
		t.Errorf("a fresh entry must survive pruning, removed %d", n)
	}
	if _, ok := c.Get("1111111111111111"); !ok {
		t.Fatal("the entry should still be there")
	}
	// Everything is older than a negative age.
	if n := c.Prune(-time.Second); n != 1 {
		t.Errorf("a stale entry must be pruned, removed %d", n)
	}
}

func TestResolveExpandsGlobsAndPrunesIgnoredTrees(t *testing.T) {
	root := t.TempDir()
	for _, p := range []string{
		"backend/a.go", "backend/sub/b.go", "frontend/x.ts",
		"frontend/node_modules/pkg/index.ts",
	} {
		full := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	got, err := Resolve(root, []string{"backend/**/*.go"}, []string{"**/node_modules/**"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"backend/a.go", "backend/sub/b.go"}
	if len(got) != len(want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("expected %v, got %v", want, got)
		}
	}

	// An ignored tree must be pruned at the directory level, not walked.
	all, err := Resolve(root, []string{"frontend/**"}, []string{"**/node_modules/**"})
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range all {
		if filepath.Base(filepath.Dir(filepath.Dir(p))) == "node_modules" {
			t.Errorf("ignored trees must not be hashed, got %s", p)
		}
	}
}

// An analyzer that declares no inputs must never be cached. That is the safe
// default: only the person writing the manifest knows what the tool reads.
func TestNoInputsMeansNoKey(t *testing.T) {
	got, err := Resolve(t.TempDir(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Errorf("no globs must resolve to no files, got %v", got)
	}
}
