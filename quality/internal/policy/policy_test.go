package policy

import (
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/quality/internal/baseline"
	"github.com/abhijeet-oxide/configer/quality/internal/model"
	"github.com/abhijeet-oxide/configer/quality/internal/spec"
)

func f(v float64) *float64 { return &v }
func b(v bool) *bool       { return &v }

func engineWith(budgets []spec.Budget, base map[string]float64) Engine {
	cfg := spec.Default()
	cfg.Budgets = budgets
	var bl *baseline.Baseline
	if base != nil {
		bl = &baseline.Baseline{Metrics: base, Findings: map[string]string{}}
	}
	return Engine{Cfg: cfg, Baseline: bl, Tier: model.TierPR, BaseRef: "origin/main"}
}

func metric(id string, v float64, unit string) model.Metric {
	return model.Metric{ID: id, Name: id, Value: v, Unit: unit,
		Direction: model.LowerBetter, Category: model.CategoryFrontend}
}

func only(t *testing.T, rs []model.BudgetResult) model.BudgetResult {
	t.Helper()
	if len(rs) != 1 {
		t.Fatalf("expected exactly one budget result, got %d", len(rs))
	}
	return rs[0]
}

// The two worked examples from the specification, asserted exactly.

func TestBundleGrowthUnderBudgetPasses(t *testing.T) {
	// 1.1 MB -> 1.2 MB is 9%... but the example says a 5% budget passes at
	// these numbers only because the example's own arithmetic is loose. What
	// the platform must do is unambiguous: compare against the stated budget.
	e := engineWith([]spec.Budget{{
		Name: "bundle-growth", Metric: "frontend.bundle.total_gzip", MaxIncreasePct: f(10),
	}}, map[string]float64{"frontend.bundle.total_gzip": 1_100_000})

	got := only(t, e.Evaluate(nil, []model.Metric{metric("frontend.bundle.total_gzip", 1_150_000, "bytes")}))
	if got.Status != model.BudgetPass {
		t.Errorf("4.5%% growth against a 10%% budget must pass, got %s: %s", got.Status, got.Message)
	}
	if got.DeltaPct == nil || *got.DeltaPct < 4 || *got.DeltaPct > 5 {
		t.Errorf("the percentage change must be reported, got %v", got.DeltaPct)
	}
}

func TestBundleGrowthOverBudgetFailsAndExplainsItself(t *testing.T) {
	e := engineWith([]spec.Budget{{
		Name: "bundle-growth", Metric: "frontend.bundle.total_gzip", MaxIncreasePct: f(5),
	}}, map[string]float64{"frontend.bundle.total_gzip": 1_100_000})

	got := only(t, e.Evaluate(nil, []model.Metric{metric("frontend.bundle.total_gzip", 1_200_000, "bytes")}))
	if got.Status != model.BudgetFail {
		t.Fatalf("9%% growth against a 5%% budget must fail, got %s", got.Status)
	}
	// The message is the product here. A failure a reader has to decode is a
	// failure they will route around.
	for _, want := range []string{"grew", "9.1%", "origin/main", "5.0%"} {
		if !strings.Contains(got.Message, want) {
			t.Errorf("the failure message must contain %q, got: %s", want, got.Message)
		}
	}
}

func TestApiCallGrowthFails(t *testing.T) {
	// The specification's example: 12 requests became 21, a 75% rise, and the
	// budget is 25%.
	e := engineWith([]spec.Budget{{
		Name: "api-call-growth", Metric: "frontend.network.requests", MaxIncreasePct: f(25),
	}}, map[string]float64{"frontend.network.requests": 12})

	got := only(t, e.Evaluate(nil, []model.Metric{metric("frontend.network.requests", 21, "count")}))
	if got.Status != model.BudgetFail {
		t.Fatalf("12 -> 21 requests against a 25%% budget must fail, got %s: %s", got.Status, got.Message)
	}
	if got.DeltaPct == nil || int(*got.DeltaPct) != 75 {
		t.Errorf("the growth must be reported as 75%%, got %v", got.DeltaPct)
	}
}

func TestRegressionBudgetWithNoBaselineIsSkippedNotPassed(t *testing.T) {
	// This is the case that decides whether the gate is trustworthy. Reporting
	// "pass" here would silently disable every regression budget on every new
	// branch, which is exactly when people believe it most.
	e := engineWith([]spec.Budget{{
		Name: "bundle-growth", Metric: "frontend.bundle.total_gzip", MaxIncreasePct: f(5),
	}}, nil)

	got := only(t, e.Evaluate(nil, []model.Metric{metric("frontend.bundle.total_gzip", 9_000_000, "bytes")}))
	if got.Status != model.BudgetSkip {
		t.Errorf("a regression budget with no baseline must be skipped, got %s", got.Status)
	}
	if got.Failed() {
		t.Error("a skipped budget must not block a merge")
	}
}

func TestUnmeasuredMetricIsSkippedNotFailed(t *testing.T) {
	e := engineWith([]spec.Budget{{
		Name: "coverage-target", Metric: "general.coverage.lines", Min: f(85),
	}}, nil)

	got := only(t, e.Evaluate(nil, nil))
	if got.Status != model.BudgetSkip {
		t.Errorf("a budget whose metric nothing produced must be skipped, got %s", got.Status)
	}
	if !strings.Contains(got.Message, "not evaluated") && !strings.Contains(got.Message, "Not measured") {
		t.Errorf("the message must say the metric was not measured, got: %s", got.Message)
	}
}

func TestAbsoluteZeroBudgetOnFindings(t *testing.T) {
	e := engineWith([]spec.Budget{{
		Name:     "no-critical-security",
		Findings: &spec.FindingSelector{Category: model.CategorySecurity, MinSeverity: model.SeverityError},
		Max:      f(0),
	}}, nil)

	findings := []model.Finding{
		{Fingerprint: "a", Category: model.CategorySecurity, Severity: model.SeverityError,
			Title: "CVE-2025-0001 in golang.org/x/net", Where: []model.Location{{Path: "backend/go.mod"}}},
		{Fingerprint: "b", Category: model.CategorySecurity, Severity: model.SeverityNote, Title: "a note"},
		{Fingerprint: "c", Category: model.CategoryFrontend, Severity: model.SeverityError, Title: "elsewhere"},
	}
	got := only(t, e.Evaluate(findings, nil))
	if got.Status != model.BudgetFail {
		t.Fatalf("one error-level security finding must fail a zero budget, got %s", got.Status)
	}
	if !strings.Contains(got.Message, "CVE-2025-0001") {
		t.Errorf("the failure must name the finding, got: %s", got.Message)
	}
	if got.Value == nil || *got.Value != 1 {
		t.Errorf("only the matching findings may be counted, got %v", got.Value)
	}
}

func TestOnlyNewSelectorIgnoresPreexistingDebt(t *testing.T) {
	// This is what makes a strict budget adoptable on a repository that already
	// has debt: hold the line without demanding the backlog be cleared first.
	e := engineWith([]spec.Budget{{
		Name:     "no-new-blocking-findings",
		Findings: &spec.FindingSelector{MinSeverity: model.SeverityError, OnlyNew: true},
		Max:      f(0),
	}}, nil)

	old := model.Finding{Fingerprint: "old", Severity: model.SeverityError, Title: "known"}
	if got := only(t, e.Evaluate([]model.Finding{old}, nil)); got.Status != model.BudgetPass {
		t.Errorf("pre-existing debt must not fail an only-new budget, got %s: %s", got.Status, got.Message)
	}

	fresh := model.Finding{Fingerprint: "new", Severity: model.SeverityError, Title: "just added", New: true}
	if got := only(t, e.Evaluate([]model.Finding{old, fresh}, nil)); got.Status != model.BudgetFail {
		t.Errorf("a newly introduced error must fail an only-new budget, got %s", got.Status)
	}
}

func TestAdvisoryBudgetDoesNotBlock(t *testing.T) {
	e := engineWith([]spec.Budget{{
		Name: "coverage-target", Metric: "general.coverage.lines", Min: f(85), Blocking: b(false),
	}}, nil)
	got := only(t, e.Evaluate(nil, []model.Metric{{
		ID: "general.coverage.lines", Name: "Line coverage", Value: 40, Unit: "percent",
		Direction: model.HigherBetter,
	}}))
	if got.Status != model.BudgetFail {
		t.Fatalf("40%% against a floor of 85%% must be reported as a failure, got %s", got.Status)
	}
	if got.Failed() {
		t.Error("an advisory budget must be reported but must not block a merge")
	}
}

func TestWildcardBudgetCoversEverySubject(t *testing.T) {
	// One budget, every benchmark: the alternative is a budget per benchmark,
	// which nobody maintains.
	e := engineWith([]spec.Budget{{
		Name: "benchmark-regression", Metric: "backend.bench.ns_per_op|*", MaxIncreasePct: f(15),
	}}, map[string]float64{
		"backend.bench.ns_per_op|BenchmarkResolve": 100,
		"backend.bench.ns_per_op|BenchmarkGrid":    200,
	})

	results := e.Evaluate(nil, []model.Metric{
		{ID: "backend.bench.ns_per_op", Subject: "BenchmarkResolve", Value: 105, Unit: "ns/op"},
		{ID: "backend.bench.ns_per_op", Subject: "BenchmarkGrid", Value: 300, Unit: "ns/op"},
	})
	if len(results) != 2 {
		t.Fatalf("a wildcard budget must produce one result per subject, got %d", len(results))
	}
	var failed int
	for _, r := range results {
		if r.Status == model.BudgetFail {
			failed++
			if !strings.Contains(r.Message, "BenchmarkGrid") {
				t.Errorf("the failing subject must be named, got: %s", r.Message)
			}
		}
	}
	if failed != 1 {
		t.Errorf("exactly the 50%% regression must fail, got %d failures", failed)
	}
}

func TestWarningLineDoesNotFail(t *testing.T) {
	e := engineWith([]spec.Budget{{
		Name: "bundle-growth", Metric: "frontend.bundle.total_gzip",
		MaxIncreasePct: f(5), WarnAt: f(2),
	}}, map[string]float64{"frontend.bundle.total_gzip": 1_000_000})

	got := only(t, e.Evaluate(nil, []model.Metric{metric("frontend.bundle.total_gzip", 1_030_000, "bytes")}))
	if got.Status != model.BudgetWarn {
		t.Errorf("3%% growth past a 2%% warning line but under a 5%% budget must warn, got %s: %s",
			got.Status, got.Message)
	}
}
