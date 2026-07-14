package grid

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// mkProject builds a write-back-native project on disk: values live in the
// instances' real files, .configer-equivalent metadata in the structs.
func mkProject(t *testing.T) *project.Project {
	t.Helper()
	root := t.TempDir()
	write := func(rel, content string) {
		t.Helper()
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// "new" overrides parameter a in its own file; "old" has no values file.
	write("instances/new/values.yaml", "a: override\n")
	// Shared base file supplies tls and legacy for every instance.
	write("shared/platform.yaml", "tls: \"1.2\"\nlegacy: \"off\"\n")

	return &project.Project{
		Root: root,
		App:  model.Application{Name: "t"},
		Catalog: model.Catalog{
			Parameters: []model.Parameter{
				{ID: "a", Name: "a", Category: "Net/IP", Type: model.TypeString,
					Default: "d", VersionIntroduced: "v1.0.0",
					Bindings: []model.Binding{{File: "{folder}/values.yaml", Path: "$.a", Format: "yaml"}}},
				{ID: "tls", Name: "tls", Category: "Net/TLS", Type: model.TypeString,
					VersionIntroduced: "v24.3.1", Scope: model.ScopeGlobal,
					Bindings: []model.Binding{{File: "shared/platform.yaml", Path: "$.tls", Format: "yaml"}}},
				{ID: "legacy", Name: "legacy", Category: "Adv", Type: model.TypeString,
					VersionIntroduced: "v1.0.0", VersionDeprecated: "v24.3.0", Scope: model.ScopeGlobal,
					Bindings: []model.Binding{{File: "shared/platform.yaml", Path: "$.legacy", Format: "yaml"}}},
			},
		},
		Registry: model.InstanceRegistry{Instances: []model.Instance{
			{Name: "new", Folder: "instances/new", SoftwareVersion: "v24.3.1"},
			{Name: "old", Folder: "instances/old", SoftwareVersion: "v24.2.0"},
		}},
	}
}

func TestCellStates(t *testing.T) {
	g := Build(mkProject(t))
	rows := map[string]Row{}
	for _, r := range g.Rows {
		rows[r.Param.ID] = r
	}

	// tls introduced at v24.3.1: "new" for the v24.3.1 instance, "na" for older.
	if got := rows["tls"].Cells["new"].State; got != StateNew {
		t.Errorf("tls@new state = %s, want new", got)
	}
	if got := rows["tls"].Cells["old"].State; got != StateNotApplicable {
		t.Errorf("tls@old state = %s, want na", got)
	}
	// legacy deprecated at v24.3.0: deprecated on newer, normal on older.
	if got := rows["legacy"].Cells["new"].State; got != StateDeprecated {
		t.Errorf("legacy@new state = %s, want deprecated", got)
	}
	if got := rows["legacy"].Cells["old"].State; got != StateNormal {
		t.Errorf("legacy@old state = %s, want normal", got)
	}
	// deprecated / na cells are not editable.
	if rows["legacy"].Cells["new"].Editable {
		t.Error("deprecated cell should not be editable")
	}
}

func TestLayerResolution(t *testing.T) {
	g := Build(mkProject(t))
	rows := map[string]Row{}
	for _, r := range g.Rows {
		rows[r.Param.ID] = r
	}
	// "a" has a default and an instance-file value on "new".
	if c := rows["a"].Cells["new"]; c.Value != "override" || c.Source != model.LayerInstance {
		t.Errorf("a@new = %v src=%s, want override/instance", c.Value, c.Source)
	}
	if c := rows["a"].Cells["old"]; c.Value != "d" || c.Source != model.LayerDefault {
		t.Errorf("a@old = %v src=%s, want d/default", c.Value, c.Source)
	}
	// The cell records WHERE the value came from.
	if c := rows["a"].Cells["new"]; c.File != "instances/new/values.yaml" {
		t.Errorf("a@new file = %s, want instances/new/values.yaml", c.File)
	}
	// "tls" comes from the shared base file.
	if c := rows["tls"].Cells["new"]; c.Value != "1.2" || c.Source != model.LayerBase {
		t.Errorf("tls@new = %v src=%s, want 1.2/base", c.Value, c.Source)
	}
}

func TestApplyDraft(t *testing.T) {
	g := Build(mkProject(t))
	ApplyDraft(&g, []change.Item{
		{ParamID: "a", Instance: "new", Action: change.ActionSet, New: "staged"},
		{ParamID: "tls", Scope: "global", Action: change.ActionSet, New: "1.3"},
	})
	rows := map[string]Row{}
	for _, r := range g.Rows {
		rows[r.Param.ID] = r
	}
	if c := rows["a"].Cells["new"]; !c.Pending || c.Value != "staged" {
		t.Errorf("a@new pending=%v value=%v, want staged pending", c.Pending, c.Value)
	}
	if c := rows["a"].Cells["old"]; c.Pending {
		t.Error("a@old must not be pending")
	}
	// A global item previews on every cell not overridden at instance layer.
	for _, inst := range []string{"new", "old"} {
		if c := rows["tls"].Cells[inst]; !c.Pending || c.Value != "1.3" {
			t.Errorf("tls@%s pending=%v value=%v, want 1.3 pending", inst, c.Pending, c.Value)
		}
	}
}

func TestCategoryTree(t *testing.T) {
	g := Build(mkProject(t))
	// Expect a top-level "Net" node with two children (IP, TLS) and an "Adv" node.
	var net *CategoryNode
	for i := range g.Categories {
		if g.Categories[i].Title == "Net" {
			net = &g.Categories[i]
		}
	}
	if net == nil {
		t.Fatal("missing Net category")
	}
	if net.Count != 2 || len(net.Children) != 2 {
		t.Errorf("Net count=%d children=%d, want 2/2", net.Count, len(net.Children))
	}
}
