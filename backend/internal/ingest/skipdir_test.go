package ingest

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/parsers"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// A repository carries a lot that is not configuration: git's own object store,
// an editor's workspace settings, a Python cache. Every one of them is full of
// files a parser will happily read, and every one of them buries the files
// somebody actually came to manage.
func TestScanSkipsToolDirectories(t *testing.T) {
	root := t.TempDir()
	write := func(rel, body string) {
		t.Helper()
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	write("instances/prod/values.yaml", "service:\n  port: 8080\n")
	write(".git/config.yaml", "core:\n  bare: false\n")
	write(".vscode/settings.json", `{"editor.tabSize": 2}`)
	write(".idea/workspace.yaml", "ide: true\n")
	write("scripts/__pycache__/cached.json", `{"stale": true}`)
	write("node_modules/pkg/package.json", `{"name": "pkg"}`)
	write("instances/prod/.terraform/state.json", `{"serial": 1}`)

	reg := plugin.NewRegistry()
	parsers.Register(reg)
	res, err := Scan(root, reg, project.Ignore{})
	if err != nil {
		t.Fatal(err)
	}

	seen := map[string]bool{}
	for _, f := range res.Files {
		seen[f.File] = true
	}
	if !seen["instances/prod/values.yaml"] {
		t.Errorf("the real config file should be scanned; got %v", seen)
	}
	for f := range seen {
		if f != "instances/prod/values.yaml" {
			t.Errorf("%s belongs to a tool, not to the configuration, and should not be scanned", f)
		}
	}
}

func TestSkipDir(t *testing.T) {
	for _, name := range []string{".git", ".configer", ".vscode", ".idea", ".terraform", "__pycache__", "node_modules", "venv"} {
		if !SkipDir(name) {
			t.Errorf("%s should be skipped", name)
		}
	}
	for _, name := range []string{"instances", "base", "overlays", "charts", "prod-us-east", "values"} {
		if SkipDir(name) {
			t.Errorf("%s is ordinary configuration and must not be skipped", name)
		}
	}
}
