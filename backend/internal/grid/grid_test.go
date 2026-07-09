package grid

import (
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

func mkProject() *project.Project {
	return &project.Project{
		Catalog: model.Catalog{
			Metadata: model.CatalogMeta{Project: "t"},
			Parameters: []model.Parameter{
				{ID: "a", Name: "a", Category: "Net/IP", Type: model.TypeString,
					Default: "d", VersionIntroduced: "v1.0.0"},
				{ID: "tls", Name: "tls", Category: "Net/TLS", Type: model.TypeString,
					VersionIntroduced: "v24.3.1"},
				{ID: "legacy", Name: "legacy", Category: "Adv", Type: model.TypeString,
					VersionIntroduced: "v1.0.0", VersionDeprecated: "v24.3.0"},
			},
		},
		Registry: model.InstanceRegistry{Instances: []model.Instance{
			{Name: "new", SoftwareVersion: "v24.3.1"},
			{Name: "old", SoftwareVersion: "v24.2.0"},
		}},
		Scopes:   model.ScopeOverlays{Global: map[string]any{"tls": "1.2", "legacy": "off"}},
		Overlays: map[string]model.Overlay{"new": {Values: map[string]any{"a": "override"}}},
	}
}

func TestCellStates(t *testing.T) {
	g := Build(mkProject())
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

func TestScopeResolution(t *testing.T) {
	g := Build(mkProject())
	rows := map[string]Row{}
	for _, r := range g.Rows {
		rows[r.Param.ID] = r
	}
	// "a" has a default and an instance override on "new".
	if c := rows["a"].Cells["new"]; c.Value != "override" || c.Source != model.ScopeInstance {
		t.Errorf("a@new = %v src=%s, want override/instance", c.Value, c.Source)
	}
	if c := rows["a"].Cells["old"]; c.Value != "d" || c.Source != model.ScopeDefault {
		t.Errorf("a@old = %v src=%s, want d/default", c.Value, c.Source)
	}
	// "tls" comes from global scope.
	if c := rows["tls"].Cells["new"]; c.Value != "1.2" || c.Source != model.ScopeGlobal {
		t.Errorf("tls@new = %v src=%s, want 1.2/global", c.Value, c.Source)
	}
}

func TestCategoryTree(t *testing.T) {
	g := Build(mkProject())
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
