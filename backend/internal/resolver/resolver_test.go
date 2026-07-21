package resolver

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

func writeFile(t *testing.T, root, rel, content string) {
	t.Helper()
	full := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A derived default computes from another parameter's effective value (with an
// optional integer offset), is overridden by a real file value, and never
// loops on a cycle.
func TestDerivedDefaults(t *testing.T) {
	root := t.TempDir()
	// admin-port lives in the instance's file (9000); metrics-port is derived
	// as admin-port + 1; ui-port is derived as admin-port with no file of its own.
	writeFile(t, root, "instances/prod/values.yaml", "net:\n  adminPort: 9000\n")

	catalog := []model.Parameter{
		{
			ID: "admin-port", Type: model.TypeInteger, Default: 8000,
			Bindings: []model.Binding{{File: "{folder}/values.yaml", Path: "$.net.adminPort", Format: "yaml"}},
		},
		{
			ID: "metrics-port", Type: model.TypeInteger, Derived: "{admin-port}+1",
			Bindings: []model.Binding{{File: "{folder}/values.yaml", Path: "$.net.metricsPort", Format: "yaml"}},
		},
		{
			ID: "ui-port", Type: model.TypeInteger, Derived: "{admin-port}",
			Bindings: []model.Binding{{File: "{folder}/values.yaml", Path: "$.net.uiPort", Format: "yaml"}},
		},
	}
	prod := model.Instance{Name: "prod", Folder: "instances/prod"}
	r := NewWithCatalog(root, catalog)

	// admin-port comes from the file.
	if got := r.Resolve(catalog[0], prod); got.Value != 9000 || got.Layer != model.LayerInstance {
		t.Errorf("admin-port = %v (%s), want 9000 (instance)", got.Value, got.Layer)
	}
	// metrics-port derives admin-port + 1, tagged as the derived layer.
	if got := r.Resolve(catalog[1], prod); got.Value != 9001 || got.Layer != model.LayerDerived {
		t.Errorf("metrics-port = %v (%s), want 9001 (derived)", got.Value, got.Layer)
	}
	// ui-port derives admin-port with no offset.
	if got := r.Resolve(catalog[2], prod); got.Value != 9000 || got.Layer != model.LayerDerived {
		t.Errorf("ui-port = %v (%s), want 9000 (derived)", got.Value, got.Layer)
	}

	// A real file value overrides the derived default.
	writeFile(t, root, "instances/prod/values.yaml", "net:\n  adminPort: 9000\n  metricsPort: 7777\n")
	r2 := NewWithCatalog(root, catalog)
	if got := r2.Resolve(catalog[1], prod); got.Value != 7777 || got.Layer != model.LayerInstance {
		t.Errorf("metrics-port with file value = %v (%s), want 7777 (instance)", got.Value, got.Layer)
	}

	// Without a catalog, derivation is disabled (backward compatible).
	if got := New(root).Resolve(catalog[2], prod); got.Set {
		t.Errorf("ui-port without catalog should be unset (no default), got %v", got.Value)
	}
}

// A self-referential or mutually-referential derivation resolves to unset
// rather than looping forever.
func TestDerivedCycleIsSafe(t *testing.T) {
	root := t.TempDir()
	catalog := []model.Parameter{
		{ID: "a", Type: model.TypeInteger, Derived: "{b}"},
		{ID: "b", Type: model.TypeInteger, Derived: "{a}"},
		{ID: "self", Type: model.TypeInteger, Derived: "{self}+1"},
	}
	inst := model.Instance{Name: "x", Folder: "instances/x"}
	r := NewWithCatalog(root, catalog)
	for _, p := range catalog {
		if got := r.Resolve(p, inst); got.Set {
			t.Errorf("cyclic %s should be unset, got %v", p.ID, got.Value)
		}
	}
}
