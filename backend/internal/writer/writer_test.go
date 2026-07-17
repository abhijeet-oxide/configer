package writer

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"gopkg.in/yaml.v3"
)

func writeCatalog(t *testing.T, root string, cat model.Catalog) {
	t.Helper()
	dir := filepath.Join(root, ".configer")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	b, _ := yaml.Marshal(cat)
	if err := os.WriteFile(filepath.Join(dir, "parameters.yaml"), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateParameter(t *testing.T) {
	root := t.TempDir()
	writeCatalog(t, root, model.Catalog{
		APIVersion: "configer.io/v1",
		Kind:       "ParameterCatalog",
		Parameters: []model.Parameter{
			{ID: "a", Name: "a", Type: model.TypeString},
			{ID: "b", Name: "b", Type: model.TypeString},
		},
	})

	newType := model.TypeInteger
	min := 100.0
	max := 500.0
	got, err := UpdateParameter(root, "b", ParamPatch{
		Type:       &newType,
		Validation: &model.Validation{Min: &min, Max: &max, Preset: "port"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Type != model.TypeInteger || *got.Validation.Min != 100 || got.Validation.Preset != "port" {
		t.Errorf("patch not applied: %+v", got)
	}

	// re-read from disk to confirm persistence and that "a" is untouched
	b2, _ := os.ReadFile(filepath.Join(root, ".configer", "parameters.yaml"))
	var cat2 model.Catalog
	if err := yaml.Unmarshal(b2, &cat2); err != nil {
		t.Fatal(err)
	}
	if cat2.Parameters[0].Type != model.TypeString {
		t.Error("parameter a was modified")
	}
	if *cat2.Parameters[1].Validation.Max != 500 {
		t.Error("max not persisted")
	}

	if _, err := UpdateParameter(root, "missing", ParamPatch{}); err == nil {
		t.Error("expected error for unknown parameter")
	}
}

func TestAttachBindings(t *testing.T) {
	root := t.TempDir()
	writeCatalog(t, root, model.Catalog{
		Parameters: []model.Parameter{{ID: "a", Name: "a", Type: model.TypeString}},
	})
	bindings := []model.Binding{{File: "{folder}/values.yaml", Path: "$.a", Format: "yaml"}}
	got, err := UpdateParameter(root, "a", ParamPatch{Bindings: &bindings})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Bindings) != 1 || got.Bindings[0].File != "{folder}/values.yaml" {
		t.Errorf("bindings not attached: %+v", got.Bindings)
	}

	// A half-specified binding is rejected.
	bad := []model.Binding{{File: "x.yaml"}}
	if _, err := UpdateParameter(root, "a", ParamPatch{Bindings: &bad}); err == nil {
		t.Error("expected error for binding without a path")
	}
}

// TestDeleteParameterRemovesFromFiles is the write-back retirement contract:
// the catalog entry goes away AND the key disappears from every bound real
// file, instance-layer and shared alike.
func TestDeleteParameterRemovesFromFiles(t *testing.T) {
	root := t.TempDir()
	write := func(rel, content string) {
		t.Helper()
		full := filepath.Join(root, rel)
		_ = os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("instances/staging/values.yaml", "app:\n  port: 8080\nkeep: 1\n")
	write("instances/prod/values.yaml", "app:\n  port: 9090\nkeep: 2\n")
	write("shared/platform.yaml", "domain: example.com\nkeep: 3\n")
	writeCatalog(t, root, model.Catalog{
		Parameters: []model.Parameter{
			{ID: "port", Name: "app.port", Type: model.TypeInteger,
				Bindings: []model.Binding{{File: "{folder}/values.yaml", Path: "$.app.port", Format: "yaml"}}},
			{ID: "domain", Name: "domain", Type: model.TypeString, Scope: model.ScopeGlobal,
				Bindings: []model.Binding{{File: "shared/platform.yaml", Path: "$.domain", Format: "yaml"}}},
		},
	})
	instances := []model.Instance{
		{Name: "staging", Folder: "instances/staging"},
		{Name: "prod", Folder: "instances/prod"},
	}

	if err := DeleteParameter(root, "port", instances); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"instances/staging/values.yaml", "instances/prod/values.yaml"} {
		b, _ := os.ReadFile(filepath.Join(root, f))
		if strings.Contains(string(b), "port:") || strings.Contains(string(b), "app:") {
			t.Errorf("%s still holds the retired key:\n%s", f, b)
		}
		if !strings.Contains(string(b), "keep:") {
			t.Errorf("%s lost unmanaged content:\n%s", f, b)
		}
	}

	if err := DeleteParameter(root, "domain", instances); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(root, "shared/platform.yaml"))
	if strings.Contains(string(b), "domain:") {
		t.Errorf("shared file still holds the retired key:\n%s", b)
	}

	// Catalog must be empty now.
	b2, _ := os.ReadFile(filepath.Join(root, ".configer", "parameters.yaml"))
	var cat model.Catalog
	_ = yaml.Unmarshal(b2, &cat)
	if len(cat.Parameters) != 0 {
		t.Errorf("catalog still has %d parameters", len(cat.Parameters))
	}
}

func TestInstanceRegistryLifecycle(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".configer"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := AddInstance(root, model.Instance{Name: "staging", Environment: "staging"}); err != nil {
		t.Fatal(err)
	}
	// duplicate rejected
	if err := AddInstance(root, model.Instance{Name: "staging"}); err == nil {
		t.Error("duplicate instance accepted")
	}
	// folder defaults to the plain-folders convention
	inst, err := UpdateInstance(root, "staging", InstancePatch{})
	if err != nil {
		t.Fatal(err)
	}
	if inst.Folder != "instances/staging" {
		t.Errorf("folder = %s, want instances/staging", inst.Folder)
	}

	// delete removes registry entry and folder
	if err := os.MkdirAll(filepath.Join(root, "instances/staging"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "instances/staging/values.yaml"), []byte("a: 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := DeleteInstance(root, "staging"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "instances/staging")); !os.IsNotExist(err) {
		t.Error("deleted instance folder still exists")
	}
}

// TestAddParametersBatch checks the batch writer: all valid params land in one
// write, duplicates (existing or within the batch) are skipped, and a large
// batch completes quickly (the O(n^2) per-param rewrite is gone).
func TestAddParametersBatch(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".configer"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Seed one existing parameter to test collision skipping.
	if err := AddParameter(root, model.Parameter{ID: "existing", Name: "a.b"}); err != nil {
		t.Fatal(err)
	}

	const n = 3000
	batch := make([]model.Parameter, 0, n+2)
	for i := 0; i < n; i++ {
		batch = append(batch, model.Parameter{ID: fmt.Sprintf("p%d", i), Name: fmt.Sprintf("x.p%d", i)})
	}
	batch = append(batch, model.Parameter{ID: "existing", Name: "dup-id"}) // dup id -> skip
	batch = append(batch, model.Parameter{ID: "newid", Name: "a.b"})       // dup name -> skip

	start := time.Now()
	added, skipped, err := AddParameters(root, batch)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatal(err)
	}
	if added != n {
		t.Fatalf("added = %d, want %d", added, n)
	}
	if len(skipped) != 2 {
		t.Fatalf("skipped = %v, want 2", skipped)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("batch of %d took %v - expected well under 2s", n, elapsed)
	}

	// Everything persisted in one catalog.
	var cat model.Catalog
	b, _ := os.ReadFile(filepath.Join(root, ".configer", "parameters.yaml"))
	if err := yaml.Unmarshal(b, &cat); err != nil {
		t.Fatal(err)
	}
	if len(cat.Parameters) != n+1 {
		t.Fatalf("catalog has %d params, want %d", len(cat.Parameters), n+1)
	}
}

// A metadata edit must be a one-line diff even in a hand-formatted registry:
// comments, flow-style labels and untouched entries keep their exact bytes.
func TestUpdateInstancePreservesFormatting(t *testing.T) {
	root := t.TempDir()
	orig := `apiVersion: configer.io/v1
kind: InstanceRegistry
# Hand-maintained comment.
instances:
  - name: prod
    folder: instances/prod
    environment: production
    softwareVersion: v1.0.0
    labels: { tier: gold }
    status: active
  - name: staging
    folder: instances/staging
    environment: staging # promoted weekly
    softwareVersion: v1.0.0
    status: active
`
	if err := os.MkdirAll(filepath.Join(root, ".configer"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".configer", "instances.yaml"), []byte(orig), 0o644); err != nil {
		t.Fatal(err)
	}

	v := "v2.0.0"
	if _, err := UpdateInstance(root, "staging", InstancePatch{SoftwareVersion: &v}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(root, ".configer", "instances.yaml"))
	// The one emitter nuance: yaml.v3 normalizes flow-map spacing
	// ({ tier: gold } -> {tier: gold}). Everything else is byte-exact.
	want := strings.Replace(strings.Replace(orig, "labels: { tier: gold }", "labels: {tier: gold}", 1), "  - name: staging\n    folder: instances/staging\n    environment: staging # promoted weekly\n    softwareVersion: v1.0.0",
		"  - name: staging\n    folder: instances/staging\n    environment: staging # promoted weekly\n    softwareVersion: v2.0.0", 1)
	if string(b) != want {
		t.Errorf("registry edit not surgical:\n--- got ---\n%s\n--- want ---\n%s", b, want)
	}
}
