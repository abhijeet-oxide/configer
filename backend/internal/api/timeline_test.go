package api

import (
	"reflect"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// state is a compact way to build a snapshotState in tests.
func state(values map[string]string, versions map[string]string) snapshotState {
	st := snapshotState{
		values:   map[string]string{},
		names:    map[string]string{},
		versions: map[string]string{},
		insts:    map[string]bool{},
	}
	for k, v := range values {
		st.values[k] = v
	}
	for n, v := range versions {
		st.versions[n] = v
		st.insts[n] = true
	}
	return st
}

// diffStates must report a cell that appeared, one that vanished and one whose
// value moved, and leave untouched cells out entirely.
func TestDiffStates(t *testing.T) {
	prev := state(map[string]string{
		cellKey("port", "prod"):  "8080",
		cellKey("tls", "prod"):   "false",
		cellKey("quota", "prod"): "10",
	}, map[string]string{"prod": "v1"})
	cur := state(map[string]string{
		cellKey("port", "prod"):     "8443",  // modified
		cellKey("tls", "prod"):      "false", // unchanged: must not appear
		cellKey("replicas", "prod"): "3",     // added
	}, map[string]string{"prod": "v1"})

	got := diffStates(prev, cur)
	if len(got) != 3 {
		t.Fatalf("diffStates returned %d changes, want 3: %+v", len(got), got)
	}
	byParam := map[string]CellChange{}
	for _, c := range got {
		byParam[c.ParamID] = c
	}
	if c := byParam["port"]; c.Status != "modified" || c.Before != "8080" || c.After != "8443" {
		t.Errorf("port = %+v, want modified 8080->8443", c)
	}
	if c := byParam["replicas"]; c.Status != "added" || c.Before != "" || c.After != "3" {
		t.Errorf("replicas = %+v, want added ->3", c)
	}
	if c := byParam["quota"]; c.Status != "removed" || c.Before != "10" || c.After != "" {
		t.Errorf("quota = %+v, want removed 10->", c)
	}
	if _, ok := byParam["tls"]; ok {
		t.Error("an unchanged cell must not appear in the diff")
	}
}

// A snapshot that moves an instance's software version reads as a version
// upgrade, even when values moved with it - that is the change a user
// recognizes, and the value detail is still carried in the summary.
func TestClassifyVersionWins(t *testing.T) {
	changes := []CellChange{
		{ParamID: "port", Instance: "prod", Status: "modified"},
		{ParamID: "tls", Instance: "prod", Status: "added"},
	}
	versions := []VersionMove{{Instance: "prod", From: "v24.3.1", To: "v24.4.0"}}

	kind, sum, instances := classify(changes, versions, nil)
	if kind != kindVersion {
		t.Errorf("kind = %q, want %q", kind, kindVersion)
	}
	if sum.Modified != 1 || sum.Added != 1 || sum.Total != 2 {
		t.Errorf("summary = %+v, want 1 modified, 1 added, total 2", sum)
	}
	if !reflect.DeepEqual(instances, []string{"prod"}) {
		t.Errorf("instances = %v, want [prod]", instances)
	}

	// Values alone is an ordinary configuration change.
	if kind, _, _ := classify(changes, nil, nil); kind != kindConfig {
		t.Errorf("kind without a version move = %q, want %q", kind, kindConfig)
	}
	// Nothing at all is the quiet state.
	if kind, _, _ := classify(nil, nil, nil); kind != kindNone {
		t.Errorf("kind with no changes = %q, want %q", kind, kindNone)
	}
	// An instance appearing is structural.
	if kind, _, _ := classify(nil, nil, []InstanceMove{{Instance: "new", Action: "added"}}); kind != kindStructural {
		t.Errorf("kind with a structural move = %q, want %q", kind, kindStructural)
	}
}

// identityMoves must separate a version bump from an instance appearing or
// being retired.
func TestIdentityMoves(t *testing.T) {
	prev := state(nil, map[string]string{"prod": "v24.3.1", "gone": "v1"})
	cur := state(nil, map[string]string{"prod": "v24.4.0", "fresh": "v1"})

	versions, structure := identityMoves(prev, cur)
	if len(versions) != 1 || versions[0].Instance != "prod" ||
		versions[0].From != "v24.3.1" || versions[0].To != "v24.4.0" {
		t.Errorf("versions = %+v, want prod v24.3.1->v24.4.0", versions)
	}
	want := []InstanceMove{{Instance: "fresh", Action: "added"}, {Instance: "gone", Action: "removed"}}
	if !reflect.DeepEqual(structure, want) {
		t.Errorf("structure = %+v, want %+v", structure, want)
	}
}

// The timeline scopes its commit log to what the view cares about: one
// instance's own folder plus the shared model, or the whole repository.
func TestTimelineLogPaths(t *testing.T) {
	p := &project.Project{
		Registry: model.InstanceRegistry{Instances: []model.Instance{
			{Name: "prod", Folder: "instances/prod"},
		}},
	}
	if got := timelineLogPaths(p, "prod"); !reflect.DeepEqual(got, []string{"instances/prod", ".configer"}) {
		t.Errorf("timelineLogPaths(prod) = %v", got)
	}
	// No instance: the whole repository (an empty path is git's "everything").
	if got := timelineLogPaths(p, ""); !reflect.DeepEqual(got, []string{""}) {
		t.Errorf("timelineLogPaths(all) = %v, want [\"\"]", got)
	}
}

// cellKey/splitCellKey must round-trip, including a global cell (no instance).
func TestCellKeyRoundTrip(t *testing.T) {
	for _, tc := range []struct{ param, inst string }{
		{"net-admin-port", "prod-us-east"},
		{"shared-timeout", ""},
	} {
		gotParam, gotInst := splitCellKey(cellKey(tc.param, tc.inst))
		if gotParam != tc.param || gotInst != tc.inst {
			t.Errorf("round-trip(%q,%q) = (%q,%q)", tc.param, tc.inst, gotParam, gotInst)
		}
	}
}
