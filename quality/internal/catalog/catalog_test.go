package catalog

import (
	"testing"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
	"github.com/abhijeet-oxide/configer/quality/internal/normalize"
	"github.com/abhijeet-oxide/configer/quality/internal/spec"
)

// The shipped catalog is data, and data is exactly the kind of thing that rots
// silently: a manifest with a typo in its output format produces a confusing
// runtime failure weeks later, on somebody else's pull request. These tests are
// the reason `cq doctor` almost never has anything to say.

func load(t *testing.T) *Catalog {
	t.Helper()
	c, err := Load(t.TempDir(), spec.Default())
	if err != nil {
		t.Fatalf("the built-in catalog did not load: %v", err)
	}
	return c
}

func TestBuiltInCatalogLoadsCleanly(t *testing.T) {
	c := load(t)
	if len(c.Problems) > 0 {
		t.Errorf("the shipped catalog must have no problems, got %v", c.Problems)
	}
	if len(c.Analyzers) < 25 {
		t.Errorf("expected the full shipped catalog, got only %d analyzers", len(c.Analyzers))
	}
}

func TestEveryManifestDeclaresAKnownFormat(t *testing.T) {
	for _, a := range load(t).Analyzers {
		if _, ok := normalize.Get(a.Output.Format); !ok {
			t.Errorf("%s declares output format %q, which no normalizer reads (%s)",
				a.ID, a.Output.Format, a.Source)
		}
	}
}

func TestEveryManifestIsUsable(t *testing.T) {
	for _, a := range load(t).Analyzers {
		if err := a.Validate(); err != nil {
			t.Errorf("%s: %v", a.Source, err)
		}
		// An analyzer with no install sentence turns a missing tool into a dead
		// end. The whole point of naming the tool is that somebody can fix it.
		if a.Tool.Install == "" && a.Tool.Command != "true" {
			t.Errorf("%s has no tool.install line, so a missing tool would not say how to fix it", a.ID)
		}
		if a.Cost == "" {
			t.Errorf("%s declares no cost, so the scheduler cannot order it", a.ID)
		}
		// A file-based output that is never written is the one failure the
		// engine reports as a platform error, so the manifest must say where
		// the tool writes.
		if a.Output.File != "" && a.Output.Format == "exit-code" {
			t.Errorf("%s names an output file but reads only the exit code", a.ID)
		}
	}
}

func TestEveryAnalyzerCoversAtLeastOneTier(t *testing.T) {
	seen := map[model.Tier]int{}
	for _, a := range load(t).Analyzers {
		for _, tier := range a.Tiers {
			seen[tier]++
		}
	}
	// The layered model is only real if every layer actually has work in it.
	for _, tier := range model.AllTiers {
		if seen[tier] == 0 {
			t.Errorf("no analyzer runs at the %s tier, so that layer does nothing", tier)
		}
	}
	// The fast layers have to stay fast, which means nothing heavy in them.
	for _, a := range load(t).Analyzers {
		if a.Cost != model.CostHeavy {
			continue
		}
		for _, tier := range a.Tiers {
			if tier == model.TierLocal || tier == model.TierPreCommit {
				t.Errorf("%s is a heavy check in the %s tier; that tier has a seconds-level budget",
					a.ID, tier)
			}
		}
	}
}

func TestDependenciesResolve(t *testing.T) {
	c := load(t)
	for _, a := range c.Analyzers {
		for _, need := range a.Needs {
			if _, ok := c.ByID(need); !ok {
				t.Errorf("%s needs %q, which no manifest defines", a.ID, need)
			}
		}
	}
}

func TestRepositoryOverridesWin(t *testing.T) {
	cfg := spec.Default()
	no := false
	cfg.Analyzers = map[string]spec.AnalyzerOverride{
		"gofmt": {Enabled: &no},
	}
	c, err := Load(t.TempDir(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	a, ok := c.ByID("gofmt")
	if !ok {
		t.Fatal("gofmt should still be in the catalog when it is disabled, just switched off")
	}
	if a.IsEnabled() {
		t.Error("a repository must be able to switch an analyzer off without forking its manifest")
	}
	for _, e := range c.Enabled() {
		if e.ID == "gofmt" {
			t.Error("a disabled analyzer must not appear in the enabled set")
		}
	}
}

func TestSecurityChecksAreNeverSkippedByTheDiff(t *testing.T) {
	// Secret scanning and dependency scanning must not depend on which files
	// changed: a credential can be pasted into a Markdown file, and a lockfile
	// can become vulnerable without anybody touching it.
	c := load(t)
	for _, id := range []string{"gitleaks", "trivy-fs"} {
		a, ok := c.ByID(id)
		if !ok {
			t.Errorf("%s is missing from the shipped catalog", id)
			continue
		}
		if !a.AlwaysRun {
			t.Errorf("%s must be alwaysRun: a security scan gated on the diff is a security scan with a hole in it", id)
		}
	}
}
