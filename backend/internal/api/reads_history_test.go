package api

import (
	"reflect"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/repobackend"

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

// A union of per-path logs must come back in the repository's OWN order.
// Commit dates cannot be trusted for this: two commits made in the same second
// compare equal, so a date sort silently leaves them in whatever order the
// paths were queried - which can present a commit as preceding one that
// actually came after it, reversing the diff built from that pair.
func TestOrderCommitsUsesRepoOrder(t *testing.T) {
	const sameSecond = "2026-07-27T17:38:56+00:00"
	// Queried per path, so the older commit happens to arrive first.
	all := []repobackend.Commit{
		{SHA: "older", Date: sameSecond},
		{SHA: "newer", Date: sameSecond},
	}
	// The repository's own log is newest-first.
	orderCommits(all, map[string]int{"newer": 0, "older": 1})

	if all[0].SHA != "newer" || all[1].SHA != "older" {
		t.Errorf("order = [%s %s], want [newer older]", all[0].SHA, all[1].SHA)
	}
}

// Commits outside the ranking window fall back to date order, and always sort
// below the ranked ones.
func TestOrderCommitsUnrankedFallBack(t *testing.T) {
	all := []repobackend.Commit{
		{SHA: "deep-old", Date: "2020-01-01T00:00:00+00:00"},
		{SHA: "ranked", Date: "2019-01-01T00:00:00+00:00"},
		{SHA: "deep-new", Date: "2021-01-01T00:00:00+00:00"},
	}
	orderCommits(all, map[string]int{"ranked": 0})

	if all[0].SHA != "ranked" {
		t.Errorf("a ranked commit must sort above unranked ones, got %s first", all[0].SHA)
	}
	if all[1].SHA != "deep-new" || all[2].SHA != "deep-old" {
		t.Errorf("unranked commits = [%s %s], want newest date first", all[1].SHA, all[2].SHA)
	}
}

// The ranking window is deep enough to cover a union but stays bounded.
func TestRankDepth(t *testing.T) {
	if got := rankDepth(1); got != 200 {
		t.Errorf("rankDepth(1) = %d, want the 200 floor", got)
	}
	if got := rankDepth(20); got != 500 {
		t.Errorf("rankDepth(20) = %d, want 500", got)
	}
	if got := rankDepth(10000); got != 2000 {
		t.Errorf("rankDepth(10000) = %d, want the 2000 ceiling", got)
	}
}
