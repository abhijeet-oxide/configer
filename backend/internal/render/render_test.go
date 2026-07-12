package render

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// fixture builds a project with two instances that diverge structurally:
//   - small: 1 NTP server, optional TLS parameter EXCLUDED, no syslog entries
//   - big:   3 NTP servers, TLS present, 2 syslog collectors (XML)
func fixture(t *testing.T) *project.Project {
	t.Helper()
	root := t.TempDir()

	write := func(rel, content string) {
		t.Helper()
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// base templates (unmanaged content must pass through)
	write("base/values.yaml", `
app:
  name: demo          # unmanaged: passes through
network:
  ntp:
    servers:
      - 10.0.0.5
  tls:
    minVersion: "1.2"
`)
	write("base/network.xml", `<?xml version="1.0"?>
<network>
  <keep custom="yes"/>
  <syslog>
    <collector>10.0.0.9</collector>
  </syslog>
</network>`)

	params := []model.Parameter{
		{ID: "ntp", Name: "network.ntp.servers", Category: "Net", Type: model.TypeList,
			ItemType: model.TypeIPv4,
			Source:   model.Source{File: "base/values.yaml", Path: "$.network.ntp.servers", Format: "yaml"}},
		{ID: "tlsmin", Name: "network.tls.minVersion", Category: "Net", Type: model.TypeString,
			Source: model.Source{File: "base/values.yaml", Path: "$.network.tls.minVersion", Format: "yaml"},
			Default: "1.2"},
		{ID: "syslog", Name: "network.syslog.collectors", Category: "Net", Type: model.TypeList,
			ItemType: model.TypeIPv4,
			Source:   model.Source{File: "base/network.xml", Path: "/network/syslog/collector", Format: "xml"}},
		{ID: "legacy", Name: "network.legacy.mode", Category: "Adv", Type: model.TypeString,
			Source: model.Source{File: "base/network.xml", Path: "/network/legacy/@mode", Format: "xml"},
			Default: "off"},
	}

	return &project.Project{
		Root:    root,
		Catalog: model.Catalog{Metadata: model.CatalogMeta{Project: "t"}, Parameters: params},
		Registry: model.InstanceRegistry{Instances: []model.Instance{
			{Name: "small"}, {Name: "big"},
		}},
		Overlays: map[string]model.Overlay{
			"small": {Values: map[string]any{
				"ntp": []any{"10.1.1.1"},
			}, Exclude: []string{"tlsmin", "syslog"}},
			"big": {Values: map[string]any{
				"ntp":    []any{"10.2.2.1", "10.2.2.2", "10.2.2.3"},
				"syslog": []any{"10.9.9.1", "10.9.9.2"},
				"legacy": "on",
			}},
		},
	}
}

func fileByPath(t *testing.T, files []OutputFile, path string) string {
	t.Helper()
	for _, f := range files {
		if f.Path == path {
			return f.Content
		}
	}
	t.Fatalf("no output file %q (have %v)", path, files)
	return ""
}

func TestYAMLCardinalityAndOmission(t *testing.T) {
	p := fixture(t)
	reg := plugin.NewRegistry()

	small, err := Instance(p, "small", reg)
	if err != nil {
		t.Fatal(err)
	}
	big, err := Instance(p, "big", reg)
	if err != nil {
		t.Fatal(err)
	}

	sy := fileByPath(t, small, "values.yaml")
	by := fileByPath(t, big, "values.yaml")

	// Different list lengths per instance.
	if strings.Count(sy, "- 10.1.1.1") != 1 || strings.Contains(sy, "10.2.2") {
		t.Errorf("small should have exactly its 1 NTP entry:\n%s", sy)
	}
	if strings.Count(by, "- 10.2.2.") != 3 {
		t.Errorf("big should have 3 NTP entries:\n%s", by)
	}

	// Excluded parameter: key AND its now-empty parent are gone entirely.
	if strings.Contains(sy, "minVersion") || strings.Contains(sy, "tls") {
		t.Errorf("excluded tls param must leave no line behind in small:\n%s", sy)
	}
	if !strings.Contains(by, "minVersion") {
		t.Errorf("big keeps the tls param (default applies):\n%s", by)
	}

	// Unmanaged base content passes through untouched.
	if !strings.Contains(sy, "name: demo") {
		t.Errorf("unmanaged content lost:\n%s", sy)
	}
}

// A parameter mapped to several files writes its value into every one of them.
func TestMultiSourceRendersEverywhere(t *testing.T) {
	root := t.TempDir()
	write := func(rel, content string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("base/a.yaml", "app:\n  name: old\n")
	write("base/b.yaml", "service:\n  app: old\n")

	p := &project.Project{
		Root: root,
		Catalog: model.Catalog{Parameters: []model.Parameter{
			{ID: "appname", Name: "app.name", Category: "App", Type: model.TypeString,
				Scope:   model.ScopeGlobal,
				Default: "myapp",
				Source:  model.Source{File: "base/a.yaml", Path: "$.app.name", Format: "yaml"},
				Sources: []model.Source{{File: "base/b.yaml", Path: "$.service.app", Format: "yaml"}}},
		}},
		Registry: model.InstanceRegistry{Instances: []model.Instance{{Name: "prod"}}},
		Overlays: map[string]model.Overlay{},
	}

	files, err := Instance(p, "prod", plugin.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	a := fileByPath(t, files, "a.yaml")
	b := fileByPath(t, files, "b.yaml")
	if !strings.Contains(a, "myapp") {
		t.Errorf("primary source a.yaml missing the value:\n%s", a)
	}
	if !strings.Contains(b, "myapp") {
		t.Errorf("secondary source b.yaml missing the value:\n%s", b)
	}
}

func TestXMLRepetitionAndRemoval(t *testing.T) {
	p := fixture(t)
	reg := plugin.NewRegistry()

	small, err := Instance(p, "small", reg)
	if err != nil {
		t.Fatal(err)
	}
	big, err := Instance(p, "big", reg)
	if err != nil {
		t.Fatal(err)
	}

	sx := fileByPath(t, small, "network.xml")
	bx := fileByPath(t, big, "network.xml")

	// Repeated elements follow each instance's list length.
	if strings.Count(bx, "<collector>") != 2 || !strings.Contains(bx, "10.9.9.2") {
		t.Errorf("big should render 2 collector elements:\n%s", bx)
	}
	if strings.Contains(sx, "<collector>") {
		t.Errorf("small excluded syslog: no collector elements at all:\n%s", sx)
	}

	// Scalar attribute set on one instance, created element chain as needed.
	if !strings.Contains(bx, `mode="on"`) {
		t.Errorf("big should carry legacy mode attr:\n%s", bx)
	}

	// Unmanaged XML passes through.
	if !strings.Contains(sx, `custom="yes"`) || !strings.Contains(bx, `custom="yes"`) {
		t.Error("unmanaged XML element lost")
	}
}

func TestJSONRendering(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "base"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "base", "app.json"),
		[]byte(`{"app":{"debug":true,"port":8080},"keep":{"x":1}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	p := &project.Project{
		Root: root,
		Catalog: model.Catalog{Parameters: []model.Parameter{
			{ID: "port", Name: "app.port", Type: model.TypeInteger,
				Source: model.Source{File: "base/app.json", Path: "$.app.port", Format: "json"}},
			{ID: "debug", Name: "app.debug", Type: model.TypeBoolean,
				Source: model.Source{File: "base/app.json", Path: "$.app.debug", Format: "json"}},
		}},
		Registry: model.InstanceRegistry{Instances: []model.Instance{{Name: "x"}}},
		Overlays: map[string]model.Overlay{
			"x": {Values: map[string]any{"port": 9090}, Exclude: []string{"debug"}},
		},
	}
	files, err := Instance(p, "x", plugin.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	got := fileByPath(t, files, "app.json")
	if !strings.Contains(got, `"port": 9090`) {
		t.Errorf("port not applied:\n%s", got)
	}
	if strings.Contains(got, "debug") {
		t.Errorf("excluded key must be absent from JSON:\n%s", got)
	}
	if !strings.Contains(got, `"keep"`) {
		t.Errorf("unmanaged JSON lost:\n%s", got)
	}
}
