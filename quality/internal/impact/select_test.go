package impact

import (
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
	"github.com/abhijeet-oxide/configer/quality/internal/spec"
)

// The selection rules are the platform's single biggest lever on cost, and the
// only part of it where being wrong is silent: an analyzer that should have run
// and did not produces a green build over broken code. So the cases below are
// the ones from the specification, asserted literally.

func testConfig() *spec.Config {
	c := spec.Default()
	return c
}

func analyzer(id string, cat model.Category, scopes []string, paths []string, tiers ...model.Tier) model.Analyzer {
	if len(tiers) == 0 {
		tiers = []model.Tier{model.TierPR}
	}
	return model.Analyzer{
		ID: id, Name: id, Category: cat, Scopes: scopes, Paths: paths, Tiers: tiers,
		Tool: model.Tool{Command: "true"}, Output: model.Output{Format: "exit-code"},
	}
}

func changed(paths ...string) []Change {
	cs := make([]Change, 0, len(paths))
	for _, p := range paths {
		cs = append(cs, Change{Path: p, Status: "M"})
	}
	return cs
}

func selectIDs(t *testing.T, s Selector, as []model.Analyzer, cs []Change) map[string]bool {
	t.Helper()
	p := s.Select(as, cs)
	out := map[string]bool{}
	for _, id := range p.SelectedIDs() {
		out[id] = true
	}
	return out
}

func TestBackendOnlyChangeSkipsFrontend(t *testing.T) {
	as := []model.Analyzer{
		analyzer("golangci", model.CategoryBackend, []string{"backend"}, nil),
		analyzer("eslint", model.CategoryFrontend, []string{"frontend"}, nil),
	}
	got := selectIDs(t, Selector{Cfg: testConfig(), Tier: model.TierPR}, as,
		changed("backend/internal/api/reads.go"))

	if !got["golangci"] {
		t.Error("a backend change must run the backend checks")
	}
	if got["eslint"] {
		t.Error("a backend change must not run the frontend checks")
	}
}

func TestFrontendOnlyChangeSkipsBackend(t *testing.T) {
	as := []model.Analyzer{
		analyzer("golangci", model.CategoryBackend, []string{"backend"}, nil),
		analyzer("eslint", model.CategoryFrontend, []string{"frontend"}, nil),
	}
	got := selectIDs(t, Selector{Cfg: testConfig(), Tier: model.TierPR}, as,
		changed("frontend/src/components/ParameterGrid.tsx"))

	if !got["eslint"] {
		t.Error("a frontend change must run the frontend checks")
	}
	if got["golangci"] {
		t.Error("a frontend change must not run the backend checks")
	}
}

func TestDocsOnlyChangeSkipsNearlyEverything(t *testing.T) {
	as := []model.Analyzer{
		analyzer("golangci", model.CategoryBackend, []string{"backend"}, nil),
		analyzer("eslint", model.CategoryFrontend, []string{"frontend"}, nil),
		analyzer("prose", model.CategoryGeneral, []string{"docs"}, nil),
		{ID: "secrets", Name: "secrets", Category: model.CategorySecurity, AlwaysRun: true,
			Tiers: []model.Tier{model.TierPR}, Tool: model.Tool{Command: "true"},
			Output: model.Output{Format: "exit-code"}},
	}
	p := Selector{Cfg: testConfig(), Tier: model.TierPR}.Select(as, changed("README.md", "docs/cqp/adr-0001.md"))
	got := map[string]bool{}
	for _, id := range p.SelectedIDs() {
		got[id] = true
	}

	if got["golangci"] || got["eslint"] {
		t.Errorf("a documentation-only change must not run code checks, got %v", p.SelectedIDs())
	}
	if !got["prose"] {
		t.Error("a documentation-only change must still run the documentation checks")
	}
	// Secret scanning is the one thing that must never be skipped: a credential
	// can be pasted into a Markdown file just as easily as into a Go file.
	if !got["secrets"] {
		t.Error("an alwaysRun analyzer must run even on a documentation-only change")
	}
	for _, s := range p.Skipped {
		if s.ID == "golangci" && !strings.Contains(s.Reason, "documentation") {
			t.Errorf("the skip reason must say why in plain words, got %q", s.Reason)
		}
	}
}

func TestCSSOnlyChangeSkipsBackend(t *testing.T) {
	as := []model.Analyzer{
		analyzer("golangci", model.CategoryBackend, []string{"backend"}, nil),
		analyzer("stylelint", model.CategoryFrontend, nil, []string{"frontend/**/*.css"}),
	}
	got := selectIDs(t, Selector{Cfg: testConfig(), Tier: model.TierPR}, as,
		changed("frontend/src/styles.css"))

	if !got["stylelint"] {
		t.Error("a CSS change must run the checks whose path triggers match it")
	}
	if got["golangci"] {
		t.Error("a CSS change must not run the backend checks")
	}
}

func TestUnclassifiedPathSelectsEverything(t *testing.T) {
	// A file the repository has not classified is the one case where being
	// conservative matters: silence over an unknown path is the failure mode of
	// incremental selection that actually hurts.
	as := []model.Analyzer{
		analyzer("golangci", model.CategoryBackend, []string{"backend"}, nil),
		analyzer("eslint", model.CategoryFrontend, []string{"frontend"}, nil),
	}
	got := selectIDs(t, Selector{Cfg: testConfig(), Tier: model.TierPR}, as,
		changed("some/unmapped/thing.conf"))

	if !got["golangci"] || !got["eslint"] {
		t.Errorf("an unclassified path must select everything, got %v", got)
	}
}

func TestPrerequisitesAreAlwaysPulledIn(t *testing.T) {
	build := analyzer("build", model.CategoryFrontend, []string{"frontend"}, nil)
	size := analyzer("bundle-size", model.CategoryFrontend, nil, []string{"never/matches/**"})
	size.Needs = []string{"build"}

	p := Selector{Cfg: testConfig(), Tier: model.TierPR, Only: []string{"bundle-size"}}.
		Select([]model.Analyzer{build, size}, changed("frontend/src/x.tsx"))

	ids := map[string]bool{}
	for _, id := range p.SelectedIDs() {
		ids[id] = true
	}
	if !ids["build"] {
		t.Errorf("a prerequisite must come along with its dependent, got %v", p.SelectedIDs())
	}
	for _, s := range p.Skipped {
		if s.ID == "build" {
			t.Error("an analyzer pulled in as a prerequisite must not also be reported as skipped")
		}
	}
}

func TestFullRunIgnoresTheDiff(t *testing.T) {
	as := []model.Analyzer{
		analyzer("golangci", model.CategoryBackend, []string{"backend"}, nil),
		analyzer("eslint", model.CategoryFrontend, []string{"frontend"}, nil),
	}
	got := selectIDs(t, Selector{Cfg: testConfig(), Tier: model.TierPR, Full: true}, as, nil)
	if !got["golangci"] || !got["eslint"] {
		t.Errorf("a full run must select everything at the tier, got %v", got)
	}
}

func TestTierGating(t *testing.T) {
	nightly := analyzer("mutation", model.CategoryTests, nil, nil, model.TierNightly)
	quick := analyzer("gofmt", model.CategoryGeneral, nil, nil, model.TierLocal, model.TierPR)

	got := selectIDs(t, Selector{Cfg: testConfig(), Tier: model.TierPR, Full: true},
		[]model.Analyzer{nightly, quick}, nil)
	if got["mutation"] {
		t.Error("a nightly-only analyzer must not run at the pull-request tier")
	}
	if !got["gofmt"] {
		t.Error("an analyzer listing the pull-request tier must run there")
	}
}

func TestClassifyNamesEveryAreaTouched(t *testing.T) {
	cfg := testConfig()
	scopes := Classify([]string{
		"backend/internal/api/reads.go",
		"frontend/src/App.tsx",
		"README.md",
	}, cfg.Scopes)

	want := map[string]bool{"backend": true, "frontend": true, "docs": true, "api": true}
	for _, s := range scopes {
		delete(want, s)
	}
	if len(want) > 0 {
		t.Errorf("these areas were not recognized: %v (got %v)", want, scopes)
	}
}
