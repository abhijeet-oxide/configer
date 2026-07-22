package writer

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"gopkg.in/yaml.v3"
)

func readSources(t *testing.T, root string) model.SourceRegistry {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, ".configer", "sources.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var reg model.SourceRegistry
	if err := yaml.Unmarshal(b, &reg); err != nil {
		t.Fatal(err)
	}
	return reg
}

func TestSourceLifecycle(t *testing.T) {
	root := t.TempDir()

	if err := AddSource(root, model.Source{ID: "git-defaults", Name: "Defaults", Kind: "git",
		Config: map[string]string{"repoUrl": "https://github.com/acme/defaults", "branch": "main"}}); err != nil {
		t.Fatal(err)
	}
	// A second source with the same id is rejected.
	if err := AddSource(root, model.Source{ID: "git-defaults", Name: "Dup", Kind: "git"}); err == nil {
		t.Fatal("expected duplicate id to be rejected")
	}
	if err := AddSource(root, model.Source{ID: "vault-prod", Name: "Prod Vault", Kind: "vault", Secret: true,
		Config: map[string]string{"address": "https://vault", "mount": "secret", "path": "telco"}}); err != nil {
		t.Fatal(err)
	}

	reg := readSources(t, root)
	if reg.APIVersion != "configer.io/v1" || reg.Kind != "SourceRegistry" {
		t.Fatalf("registry header not set: %+v", reg)
	}
	if len(reg.Sources) != 2 {
		t.Fatalf("want 2 sources, got %d", len(reg.Sources))
	}

	// Patch: rename and change config; other sources untouched.
	name := "Shared defaults"
	newCfg := map[string]string{"repoUrl": "https://github.com/acme/defaults", "branch": "release", "path": "net.yaml"}
	got, err := UpdateSource(root, "git-defaults", SourcePatch{Name: &name, Config: &newCfg})
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Shared defaults" || got.Config["branch"] != "release" {
		t.Fatalf("patch not applied: %+v", got)
	}
	reg = readSources(t, root)
	if s, ok := sourceByID(reg, "vault-prod"); !ok || !s.Secret {
		t.Fatal("vault source was disturbed by the git patch")
	}

	// Delete.
	if err := DeleteSource(root, "git-defaults"); err != nil {
		t.Fatal(err)
	}
	reg = readSources(t, root)
	if _, ok := sourceByID(reg, "git-defaults"); ok {
		t.Fatal("source was not deleted")
	}
	if err := DeleteSource(root, "missing"); err == nil {
		t.Fatal("expected deleting an unknown source to error")
	}
}

func TestMapParameterSource(t *testing.T) {
	root := t.TempDir()
	writeCatalog(t, root, model.Catalog{
		APIVersion: "configer.io/v1", Kind: "ParameterCatalog",
		Parameters: []model.Parameter{{ID: "port", Name: "net.port", Type: model.TypeInteger}},
	})

	ref := &model.SourceRef{SourceID: "git-defaults", Key: "$.net.port"}
	if err := MapParameterSource(root, "port", ref); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(root, ".configer", "parameters.yaml"))
	var cat model.Catalog
	if err := yaml.Unmarshal(b, &cat); err != nil {
		t.Fatal(err)
	}
	if cat.Parameters[0].Source == nil || cat.Parameters[0].Source.Key != "$.net.port" {
		t.Fatalf("mapping not persisted: %+v", cat.Parameters[0].Source)
	}

	// An incomplete mapping is rejected.
	if err := MapParameterSource(root, "port", &model.SourceRef{SourceID: "x"}); err == nil {
		t.Fatal("expected mapping without a key to be rejected")
	}

	// Clearing removes the mapping.
	if err := MapParameterSource(root, "port", nil); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(filepath.Join(root, ".configer", "parameters.yaml"))
	cat = model.Catalog{}
	_ = yaml.Unmarshal(b, &cat)
	if cat.Parameters[0].Source != nil {
		t.Fatal("mapping was not cleared")
	}
}

func sourceByID(reg model.SourceRegistry, id string) (model.Source, bool) {
	for _, s := range reg.Sources {
		if s.ID == id {
			return s, true
		}
	}
	return model.Source{}, false
}
