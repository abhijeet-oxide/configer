package sources

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/parsers"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
)

// fixtureRepo builds a throwaway local git repository with a config file so the
// git source can be exercised without any network. gitSource clones a
// non-github URL (here a local path) into a temp dir and reads from disk.
func fixtureRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	if err := os.MkdirAll(filepath.Join(dir, "defaults"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "defaults", "network.yaml"),
		[]byte("network:\n  admin:\n    port: 8443\n  mtu: 1500\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-q", "-m", "seed")
	return dir
}

func newGitSource() gitSource {
	reg := plugin.NewRegistry()
	parsers.Register(reg)
	return gitSource{reg: reg}
}

func TestGitSourceFetchFile(t *testing.T) {
	repo := fixtureRepo(t)
	g := newGitSource()
	cfg := plugin.SourceConfig{Values: map[string]string{"repoUrl": repo, "branch": "main", "path": "defaults/network.yaml"}}

	kvs, err := g.Fetch(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]any{}
	for _, kv := range kvs {
		byKey[kv.Key] = kv.Value
	}
	if got := byKey["$.network.admin.port"]; got != 8443 {
		t.Fatalf("want port 8443, got %v (all: %+v)", got, byKey)
	}
	if _, ok := byKey["$.network.mtu"]; !ok {
		t.Fatalf("expected mtu key, got %+v", byKey)
	}
}

func TestGitSourceBrowse(t *testing.T) {
	repo := fixtureRepo(t)
	g := newGitSource()
	cfg := plugin.SourceConfig{Values: map[string]string{"repoUrl": repo, "branch": "main"}}

	root, err := g.Browse(context.Background(), cfg, "")
	if err != nil {
		t.Fatal(err)
	}
	var sawDefaults bool
	for _, e := range root {
		if e.Name == "defaults" && e.IsDir {
			sawDefaults = true
		}
	}
	if !sawDefaults {
		t.Fatalf("expected a 'defaults' folder at the root, got %+v", root)
	}

	inside, err := g.Browse(context.Background(), cfg, "defaults")
	if err != nil {
		t.Fatal(err)
	}
	var sawFile bool
	for _, e := range inside {
		if e.Name == "network.yaml" && !e.IsDir {
			sawFile = true
		}
	}
	if !sawFile {
		t.Fatalf("expected network.yaml inside defaults, got %+v", inside)
	}
}
