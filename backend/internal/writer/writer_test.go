package writer

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"gopkg.in/yaml.v3"
)

func TestSetValueRoundTrip(t *testing.T) {
	root := t.TempDir()

	if err := SetValue(root, "staging", "p1", int64(9000)); err != nil {
		t.Fatal(err)
	}
	if err := SetValue(root, "staging", "p2", "hello"); err != nil {
		t.Fatal(err)
	}
	// overwrite p1
	if err := SetValue(root, "staging", "p1", int64(9001)); err != nil {
		t.Fatal(err)
	}

	b, err := os.ReadFile(filepath.Join(root, ".configer", "instances", "staging", "overlay.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var ov model.Overlay
	if err := yaml.Unmarshal(b, &ov); err != nil {
		t.Fatal(err)
	}
	if ov.Kind != "Overlay" || ov.Instance != "staging" {
		t.Errorf("header = %s/%s", ov.Kind, ov.Instance)
	}
	if ov.Values["p1"] != 9001 {
		t.Errorf("p1 = %v, want 9001", ov.Values["p1"])
	}
	if ov.Values["p2"] != "hello" {
		t.Errorf("p2 = %v", ov.Values["p2"])
	}
}

func TestUpdateParameter(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".configer")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	cat := model.Catalog{
		APIVersion: "configer.io/v1",
		Kind:       "ParameterCatalog",
		Parameters: []model.Parameter{
			{ID: "a", Name: "a", Type: model.TypeString},
			{ID: "b", Name: "b", Type: model.TypeString},
		},
	}
	b, _ := yaml.Marshal(cat)
	if err := os.WriteFile(filepath.Join(dir, "catalog.yaml"), b, 0o644); err != nil {
		t.Fatal(err)
	}

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
	b2, _ := os.ReadFile(filepath.Join(dir, "catalog.yaml"))
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
