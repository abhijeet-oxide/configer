package dedupe

import (
	"testing"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

func at(path string, line int) []model.Location {
	return []model.Location{{Path: path, Line: line}}
}

func TestSameToolReportingTwiceCollapses(t *testing.T) {
	f := model.Finding{
		Analyzer: "eslint", Rule: "no-unused-vars", Category: model.CategoryFrontend,
		Severity: model.SeverityWarning, Title: "'x' is defined but never used",
		Where: at("frontend/src/a.ts", 10), Tools: []string{"eslint"}, Occurrences: 1,
	}
	got := Merge([]model.Finding{f, f})
	if len(got) != 1 {
		t.Fatalf("the same finding twice must collapse to one, got %d", len(got))
	}
	if got[0].Occurrences != 2 {
		t.Errorf("the merge must record that it collapsed two results, got %d", got[0].Occurrences)
	}
}

func TestTwoToolsAgreeingBecomeOneFindingWithHigherConfidence(t *testing.T) {
	// This is the case the whole package exists for: running overlapping tools
	// on purpose is how coverage is achieved, and without a merge the report
	// would be three times the size for the same information.
	a := model.Finding{
		Analyzer: "golangci-lint", Rule: "errcheck", Category: model.CategoryBackend,
		Severity: model.SeverityWarning, Conf: model.ConfidenceMedium,
		Title: "Error return value is not checked",
		Where: at("backend/internal/api/files.go", 42), Tools: []string{"golangci-lint"},
		Fix: model.Fix{SafeToAutomate: true, Recommendation: "check it"},
	}
	b := model.Finding{
		Analyzer: "semgrep", Rule: "go.unchecked-error", Category: model.CategoryBackend,
		Severity: model.SeverityError, Conf: model.ConfidenceMedium,
		Title: "unchecked error return value",
		Where: at("backend/internal/api/files.go", 42), Tools: []string{"semgrep"},
		Fix: model.Fix{SafeToAutomate: false, Recommendation: "handle the returned error properly"},
	}

	got := Merge([]model.Finding{a, b})
	if len(got) != 1 {
		t.Fatalf("two tools reporting one problem must merge, got %d findings", len(got))
	}
	m := got[0]
	if m.Severity != model.SeverityError {
		t.Errorf("the merge must keep the worst severity, got %s", m.Severity)
	}
	if m.Conf != model.ConfidenceHigh {
		t.Errorf("two independent tools agreeing must raise confidence, got %s", m.Conf)
	}
	if len(m.Tools) != 2 {
		t.Errorf("the merge must record both tools, got %v", m.Tools)
	}
	// Automation safety is a floor, not an average. If either tool says the fix
	// is not mechanical, an agent must not apply it unattended.
	if m.Fix.SafeToAutomate {
		t.Error("automation safety must be the floor of the merged findings, not the ceiling")
	}
	if m.Fix.Recommendation != "handle the returned error properly" {
		t.Errorf("the merge must keep the more actionable remediation, got %q", m.Fix.Recommendation)
	}
}

func TestDifferentProblemsOnOneLineStaySeparate(t *testing.T) {
	a := model.Finding{
		Analyzer: "eslint", Rule: "no-unused-vars", Category: model.CategoryFrontend,
		Severity: model.SeverityWarning, Title: "'config' is defined but never used",
		Where: at("frontend/src/a.ts", 7), Tools: []string{"eslint"},
	}
	b := model.Finding{
		Analyzer: "eslint", Rule: "react-hooks/exhaustive-deps", Category: model.CategoryFrontend,
		Severity: model.SeverityWarning, Title: "React Hook useEffect has a missing dependency",
		Where: at("frontend/src/a.ts", 7), Tools: []string{"eslint"},
	}
	if got := Merge([]model.Finding{a, b}); len(got) != 2 {
		t.Errorf("two unrelated problems on one line must stay separate, got %d", len(got))
	}
}

func TestFindingsWithNoLocationAreNeverCrossMerged(t *testing.T) {
	// Without a location there is nothing to be confident about, so merging on
	// message shape alone would silently swallow distinct problems.
	a := model.Finding{Analyzer: "smoke", Rule: "smoke", Title: "the build failed",
		Category: model.CategoryTests, Severity: model.SeverityError}
	b := model.Finding{Analyzer: "typescript", Rule: "typescript", Title: "the build failed",
		Category: model.CategoryTests, Severity: model.SeverityError}
	if got := Merge([]model.Finding{a, b}); len(got) != 2 {
		t.Errorf("findings with no location must not be cross-merged, got %d", len(got))
	}
}

func TestFingerprintSurvivesALineMove(t *testing.T) {
	// A fingerprint that changes when somebody adds an import above the finding
	// makes the baseline worthless: every reformat would look like a wave of
	// new problems.
	before := model.ComputeFingerprint("no-unused-vars", "src/a.ts", "'x' is defined but never used")
	after := model.ComputeFingerprint("no-unused-vars", "src/a.ts", "'x' is defined but never used")
	if before != after {
		t.Error("the same finding must fingerprint the same way twice")
	}
	// Numbers inside a message vary run to run and must not be part of identity.
	slow1 := model.ComputeFingerprint("slow", "api.ts", "the request took 812ms")
	slow2 := model.ComputeFingerprint("slow", "api.ts", "the request took 830ms")
	if slow1 != slow2 {
		t.Error("a measurement in the message must not change the finding's identity")
	}
	// A genuinely different message must not collide.
	other := model.ComputeFingerprint("slow", "api.ts", "the request was refused")
	if other == slow1 {
		t.Error("two different problems must not share a fingerprint")
	}
}

func TestSortPutsTheWorstAndNewestFirst(t *testing.T) {
	fs := []model.Finding{
		{Fingerprint: "1", Severity: model.SeverityNote, Title: "note"},
		{Fingerprint: "2", Severity: model.SeverityError, Title: "old error"},
		{Fingerprint: "3", Severity: model.SeverityError, Title: "new error", New: true},
		{Fingerprint: "4", Severity: model.SeverityBlocker, Title: "blocker"},
	}
	model.SortFindings(fs)
	want := []string{"4", "3", "2", "1"}
	for i, w := range want {
		if fs[i].Fingerprint != w {
			t.Fatalf("position %d should be %s, got %s (%s)", i, w, fs[i].Fingerprint, fs[i].Title)
		}
	}
}
