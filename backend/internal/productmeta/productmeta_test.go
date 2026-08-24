package productmeta

import (
	"os"
	"path/filepath"
	"testing"
)

const descriptor = `{
  "product_name": "Acme-Core",
  "display_name": "Acme Core Platform",
  "version": "25.7.1120",
  "product_variant": "k8s",
  "product_release_version": "25.7",
  "envtype": "lab",
  "tenant_id": "t-1",
  "artifacts": [{"filename": "a.zip"}]
}`

// repo writes an instance folder and returns the repository root.
func repo(t *testing.T, dirs []string, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for _, d := range dirs {
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(d)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for path, content := range files {
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestDescriptorIsReadWhateverTheCase(t *testing.T) {
	root := repo(t,
		[]string{"instances/one/Configuration"},
		map[string]string{"instances/one/Metadata/Product.txt": descriptor},
	)

	d, found := ForFolder(root, "instances/one")
	if !found {
		t.Fatal("descriptor not found")
	}
	if d.Product != "Acme-Core" || d.DisplayName != "Acme Core Platform" {
		t.Errorf("names = %q / %q", d.Product, d.DisplayName)
	}
	if d.Version != "25.7.1120" || d.Release != "25.7" || d.Variant != "k8s" {
		t.Errorf("release facts = %+v", d)
	}
	if d.Environment != "lab" {
		t.Errorf("environment = %q, want lab", d.Environment)
	}
	if d.Extra["tenantId"] != "t-1" {
		t.Errorf("extra = %v", d.Extra)
	}
	if d.File != "instances/one/Metadata/Product.txt" {
		t.Errorf("file = %q, want the path it was read from", d.File)
	}
}

func TestTheShapeIsWhatMakesItTheDescriptor(t *testing.T) {
	// A metadata directory alone is a folder that happens to hold a file with
	// that name, not the pattern.
	root := repo(t, nil, map[string]string{"instances/one/METADATA/product.txt": descriptor})
	if _, found := ForFolder(root, "instances/one"); found {
		t.Error("read a descriptor from a folder that does not follow the pattern")
	}
}

func TestOrdinaryReasonsToFindNothingAreNotErrors(t *testing.T) {
	for name, files := range map[string]map[string]string{
		"no descriptor at all": {"instances/one/CONFIGURATION/values.yaml": "a: 1"},
		"not json":             {"instances/one/METADATA/product.txt": "just some notes"},
		"names nothing usable": {"instances/one/METADATA/product.txt": `{"customer_id":"9"}`},
	} {
		t.Run(name, func(t *testing.T) {
			root := repo(t, []string{"instances/one/CONFIGURATION", "instances/one/METADATA"}, files)
			if _, found := ForFolder(root, "instances/one"); found {
				t.Error("found a descriptor where there is none")
			}
		})
	}
}

func TestLabelFallsBackToTheProductId(t *testing.T) {
	d := Descriptor{Product: "Acme-Core"}
	if d.Label() != "Acme-Core" {
		t.Errorf("label = %q", d.Label())
	}
	d.DisplayName = "Acme Core Platform"
	if d.Label() != "Acme Core Platform" {
		t.Errorf("label = %q", d.Label())
	}
}
