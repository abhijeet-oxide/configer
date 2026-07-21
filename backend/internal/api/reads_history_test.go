package api

import (
	"reflect"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// cellLogPaths must scope a value timeline to the files that actually hold the
// value: the base-layer file, the selected instance's own file (folder token
// expanded), and .configer for metadata edits - so the history reflects real
// value commits, not only .configer changes.
func TestCellLogPaths(t *testing.T) {
	p := &project.Project{
		Root: "/tmp",
		Catalog: model.Catalog{Parameters: []model.Parameter{{
			ID:   "p1",
			Name: "app.port",
			Type: "integer",
			Bindings: []model.Binding{
				{File: "shared/base.yaml", Path: "$.app.port", Format: "yaml", Layer: "base"},
				{File: "{folder}/values.yaml", Path: "$.app.port", Format: "yaml"},
			},
		}}},
		Registry: model.InstanceRegistry{Instances: []model.Instance{
			{Name: "prod", Folder: "instances/prod"},
		}},
	}

	got := cellLogPaths(p, "p1", "prod")
	want := []string{"shared/base.yaml", "instances/prod/values.yaml", ".configer"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("cellLogPaths(prod) = %v, want %v", got, want)
	}

	// Without an instance, only the base-layer file and .configer are in scope.
	got = cellLogPaths(p, "p1", "")
	want = []string{"shared/base.yaml", ".configer"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("cellLogPaths(default) = %v, want %v", got, want)
	}

	// An unknown parameter degrades to metadata-only history.
	got = cellLogPaths(p, "nope", "prod")
	if !reflect.DeepEqual(got, []string{".configer"}) {
		t.Errorf("cellLogPaths(unknown) = %v, want [.configer]", got)
	}
}
