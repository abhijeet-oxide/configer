package layout

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

func TestDetectKustomize(t *testing.T) {
	d := Detect("testdata/kustomize")
	if d.Layout != KindKustomize {
		t.Fatalf("layout = %s, want kustomize", d.Layout)
	}
	if len(d.Instances) != 2 || d.Instances[0].Name != "prod" || d.Instances[1].Name != "staging" {
		t.Errorf("instances = %+v", d.Instances)
	}
	if d.Instances[0].Folder != "overlays/prod" {
		t.Errorf("folder = %s, want overlays/prod", d.Instances[0].Folder)
	}
	if d.Instances[0].Environment != "production" {
		t.Errorf("env = %s, want production", d.Instances[0].Environment)
	}
	if len(d.BaseDirs) != 1 || d.BaseDirs[0] != "base" {
		t.Errorf("baseDirs = %v, want [base]", d.BaseDirs)
	}
}

func TestDetectKpt(t *testing.T) {
	d := Detect("testdata/kpt")
	if d.Layout != KindKpt {
		t.Fatalf("layout = %s, want kpt", d.Layout)
	}
	if len(d.Instances) != 2 || d.Instances[0].Folder != "packages/dev" {
		t.Errorf("instances = %+v", d.Instances)
	}
}

func TestDetectPlainFolders(t *testing.T) {
	d := Detect("testdata/plain")
	if d.Layout != KindPlainFolders {
		t.Fatalf("layout = %s, want plain-folders", d.Layout)
	}
	if len(d.Instances) != 2 || d.Instances[1].Folder != "instances/prod" {
		t.Errorf("instances = %+v", d.Instances)
	}
	if len(d.BaseDirs) != 1 || d.BaseDirs[0] != "shared" {
		t.Errorf("baseDirs = %v, want [shared]", d.BaseDirs)
	}
}

// TestDetectSingleNestedInstance covers the Flux/GitOps shape from the field: a
// single instance folder whose config values live several directories deep
// (instances/<name>/values/<component>/values.yaml), with no direct config file
// at the instance root. It must still be recognized as one instance.
func TestDetectSingleNestedInstance(t *testing.T) {
	root := t.TempDir()
	deep := filepath.Join(root, "instances", "wnv7a0vbgw0012c", "values", "cliagent")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deep, "values.yaml"), []byte("global:\n  namespace: wnv7a0vbgw0012c\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	d := Detect(root)
	if d.Layout != KindPlainFolders {
		t.Fatalf("layout = %s, want plain-folders", d.Layout)
	}
	if len(d.Instances) != 1 || d.Instances[0].Name != "wnv7a0vbgw0012c" {
		t.Fatalf("instances = %+v, want one named wnv7a0vbgw0012c", d.Instances)
	}
	if d.Instances[0].Folder != "instances/wnv7a0vbgw0012c" {
		t.Fatalf("folder = %s, want instances/wnv7a0vbgw0012c", d.Instances[0].Folder)
	}
}

// TestDetectNestedGitopsTree covers a repo that keeps its instances under a
// subfolder (a one-level-nested GitOps tree) rather than at the root.
func TestDetectNestedGitopsTree(t *testing.T) {
	root := t.TempDir()
	deep := filepath.Join(root, "gitops", "instances", "site-a", "app")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deep, "values.yaml"), []byte("port: 8080\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	d := Detect(root)
	if len(d.Instances) != 1 || d.Instances[0].Folder != "gitops/instances/site-a" {
		t.Fatalf("instances = %+v, want one at gitops/instances/site-a", d.Instances)
	}
}

func TestSettersIn(t *testing.T) {
	b, err := os.ReadFile("testdata/kpt/packages/prod/config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	setters := SettersIn(b)
	if setters["replicas"] != "replicas" || setters["region"] != "region" {
		t.Errorf("setters = %v", setters)
	}
}

// copyFixture clones a testdata tree into a temp dir so scaffolds can write.
func copyFixture(t *testing.T, from string) string {
	t.Helper()
	root := t.TempDir()
	err := filepath.WalkDir(from, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(from, path)
		target := filepath.Join(root, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func TestScaffoldKustomize(t *testing.T) {
	root := copyFixture(t, "testdata/kustomize")
	from := model.Instance{Name: "prod", Folder: "overlays/prod"}

	inst, err := ForKind(KindKustomize).Scaffold(root, from, "dr")
	if err != nil {
		t.Fatal(err)
	}
	if inst.Folder != "overlays/dr" {
		t.Errorf("folder = %s, want overlays/dr", inst.Folder)
	}
	// The copy exists and self-references were renamed (nameSuffix: -prod -> -dr).
	b, err := os.ReadFile(filepath.Join(root, "overlays/dr/kustomization.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if string(b) == "" || !strings.Contains(string(b), "-dr") || strings.Contains(string(b), "-prod") {
		t.Errorf("kustomization not adapted:\n%s", b)
	}
	// ../../base reference still resolves from the new depth.
	if _, err := os.Stat(filepath.Join(root, "overlays/dr/patch.yaml")); err != nil {
		t.Error("patch.yaml not copied")
	}
	// Scaffolding over an existing folder must fail.
	if _, err := ForKind(KindKustomize).Scaffold(root, from, "staging"); err == nil {
		t.Error("expected error scaffolding onto an existing folder")
	}
}

func TestScaffoldKpt(t *testing.T) {
	root := copyFixture(t, "testdata/kpt")
	from := model.Instance{Name: "prod", Folder: "packages/prod"}
	inst, err := ForKind(KindKpt).Scaffold(root, from, "eu")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(root, inst.FolderOrDefault(), "Kptfile"))
	if !strings.Contains(string(b), "name: eu") {
		t.Errorf("Kptfile not renamed:\n%s", b)
	}
}
