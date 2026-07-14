package writeback

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// write a base file into a temp root and return the root.
func setup(t *testing.T, file, content string) string {
	t.Helper()
	root := t.TempDir()
	full := filepath.Join(root, file)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if content != "" {
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func read(t *testing.T, root, file string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, file))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestYAMLSetPreservesCommentsAndOrder(t *testing.T) {
	base := "# top comment\nservice:\n  ip: 10.0.0.1 # the ip\n  port: 8080\nother: keep-me\n"
	root := setup(t, "base/values.yaml", base)

	if err := SetValue(root, "base/values.yaml", "yaml", "$.service.ip", model.TypeIPv4, "10.9.9.9"); err != nil {
		t.Fatal(err)
	}
	got := read(t, root, "base/values.yaml")

	if !strings.Contains(got, "ip: 10.9.9.9") {
		t.Errorf("value not updated:\n%s", got)
	}
	for _, want := range []string{"# top comment", "# the ip", "port: 8080", "other: keep-me"} {
		if !strings.Contains(got, want) {
			t.Errorf("lost %q (comments/order/unmanaged content not preserved):\n%s", want, got)
		}
	}
	// order preserved: service before other, ip before port
	if strings.Index(got, "service:") > strings.Index(got, "other:") {
		t.Errorf("key order changed:\n%s", got)
	}
	if strings.Index(got, "ip:") > strings.Index(got, "port:") {
		t.Errorf("nested key order changed:\n%s", got)
	}
}

func TestYAMLSetCreatesNestedPath(t *testing.T) {
	root := setup(t, "base/values.yaml", "existing: 1\n")
	if err := SetValue(root, "base/values.yaml", "yaml", "$.a.b.c", model.TypeString, "deep"); err != nil {
		t.Fatal(err)
	}
	got := read(t, root, "base/values.yaml")
	if !strings.Contains(got, "existing: 1") || !strings.Contains(got, "c: deep") {
		t.Errorf("nested create failed:\n%s", got)
	}
}

func TestYAMLSetNewFile(t *testing.T) {
	root := t.TempDir()
	if err := SetValue(root, "base/new.yaml", "yaml", "$.foo.bar", model.TypeInteger, 42); err != nil {
		t.Fatal(err)
	}
	got := read(t, root, "base/new.yaml")
	if !strings.Contains(got, "bar: 42") {
		t.Errorf("new file content wrong:\n%s", got)
	}
}

func TestYAMLRemovePrunesEmptyParents(t *testing.T) {
	base := "service:\n  ip: 10.0.0.1\nkeep: yes\n"
	root := setup(t, "base/values.yaml", base)
	if err := RemoveValue(root, "base/values.yaml", "yaml", "$.service.ip", model.TypeIPv4); err != nil {
		t.Fatal(err)
	}
	got := read(t, root, "base/values.yaml")
	if strings.Contains(got, "ip:") {
		t.Errorf("value not removed:\n%s", got)
	}
	if strings.Contains(got, "service:") {
		t.Errorf("empty parent not pruned:\n%s", got)
	}
	if !strings.Contains(got, "keep: yes") {
		t.Errorf("unrelated key removed:\n%s", got)
	}
}

func TestYAMLSetList(t *testing.T) {
	root := setup(t, "base/values.yaml", "servers: [1.1.1.1]\nkeep: 1\n")
	if err := SetValue(root, "base/values.yaml", "yaml", "$.servers", model.TypeList, []any{"a", "b", "c"}); err != nil {
		t.Fatal(err)
	}
	got := read(t, root, "base/values.yaml")
	for _, want := range []string{"- a", "- b", "- c", "keep: 1"} {
		if !strings.Contains(got, want) {
			t.Errorf("list write missing %q:\n%s", want, got)
		}
	}
}

func TestJSONSetValue(t *testing.T) {
	root := setup(t, "config.json", "{\n  \"service\": {\n    \"port\": 8080\n  }\n}\n")
	if err := SetValue(root, "config.json", "json", "$.service.port", model.TypeInteger, 9090); err != nil {
		t.Fatal(err)
	}
	got := read(t, root, "config.json")
	if !strings.Contains(got, "9090") {
		t.Errorf("json value not updated:\n%s", got)
	}
}

func TestXMLSetElementText(t *testing.T) {
	root := setup(t, "network.xml", "<network>\n  <service>\n    <ip>10.0.0.1</ip>\n  </service>\n</network>\n")
	if err := SetValue(root, "network.xml", "xml", "/network/service/ip", model.TypeIPv4, "10.9.9.9"); err != nil {
		t.Fatal(err)
	}
	got := read(t, root, "network.xml")
	if !strings.Contains(got, "10.9.9.9") {
		t.Errorf("xml value not updated:\n%s", got)
	}
}
