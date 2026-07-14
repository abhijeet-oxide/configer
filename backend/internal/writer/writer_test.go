package writer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

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
