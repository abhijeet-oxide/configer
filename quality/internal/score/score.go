// Package score reduces a run to one number per category and one overall.
//
// A single number is a blunt instrument and this package does not pretend
// otherwise. It exists for exactly two jobs: giving a trend line something to
// plot, and letting a reviewer see at a glance whether a change made things
// better or worse. Every gate decision is made by the policy engine on real
// budgets, never on the score, so a wrong weight here can never block a merge.
package score

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
	"github.com/abhijeet-oxide/configer/quality/internal/spec"
)

// Compute produces the per-category reports and the overall summary numbers.
func Compute(cfg *spec.Config, findings []model.Finding, metrics []model.Metric,
	budgets []model.BudgetResult) ([]model.CategoryReport, int) {

	byCategory := map[model.Category][]model.Finding{}
	for _, f := range findings {
		byCategory[f.Category] = append(byCategory[f.Category], f)
	}
	metricCount := map[model.Category]int{}
	for _, m := range metrics {
		metricCount[m.Category]++
	}
	budgetFails := map[model.Category]int{}
	for _, b := range budgets {
		if b.Status == model.BudgetFail {
			budgetFails[b.Category]++
		}
	}

	var reports []model.CategoryReport
	for _, c := range model.AllCategories {
		fs := byCategory[c]
		if len(fs) == 0 && metricCount[c] == 0 && budgetFails[c] == 0 {
			// A category nothing measured is absent from the report rather than
			// scored 100. A perfect score for work that never ran is the single
			// most misleading thing a quality dashboard can show.
			continue
		}
		counts := map[string]int{}
		penalty := 0.0
		for _, f := range fs {
			counts[string(f.Severity)]++
			p := cfg.Scoring.Penalty[string(f.Severity)]
			// Low-confidence findings cost less. They are still worth reporting,
			// but a heuristic should not be able to tank a score on its own.
			switch f.Conf {
			case model.ConfidenceLow:
				p *= 0.3
			case model.ConfidenceMedium:
				p *= 0.7
			}
			penalty += p
		}
		penalty += float64(budgetFails[c]) * cfg.Scoring.BudgetFailPenalty

		s := int(math.Round(clamp(100-penalty, cfg.Scoring.Floor, 100)))
		reports = append(reports, model.CategoryReport{
			Category: c,
			Score:    s,
			Verdict:  verdictFor(c, budgets, counts),
			Counts:   counts,
			Findings: len(fs),
			Metrics:  metricCount[c],
		})
	}

	overall := 100
	if len(reports) > 0 {
		var sum, weightSum float64
		for _, r := range reports {
			w := cfg.Scoring.CategoryWeights[string(r.Category)]
			if w == 0 {
				w = 1
			}
			sum += float64(r.Score) * w
			weightSum += w
		}
		overall = int(math.Round(sum / weightSum))
	}
	return reports, overall
}

func verdictFor(c model.Category, budgets []model.BudgetResult, counts map[string]int) model.Verdict {
	for _, b := range budgets {
		if b.Category == c && b.Failed() {
			return model.VerdictFail
		}
	}
	if counts[string(model.SeverityBlocker)] > 0 {
		return model.VerdictFail
	}
	if counts[string(model.SeverityError)] > 0 || counts[string(model.SeverityWarning)] > 0 {
		return model.VerdictWarn
	}
	return model.VerdictPass
}

// Summarize builds the part of the report a reader sees first. The headline is
// written here, in one sentence, because a summary that says "3 issues found"
// tells nobody whether to care.
func Summarize(findings []model.Finding, budgets []model.BudgetResult,
	overall int, newCount, fixedCount int, hasBaseline bool, scoreDelta int, trend string) model.Summary {

	counts := map[string]int{}
	for _, f := range findings {
		counts[string(f.Severity)]++
	}

	var blocked []string
	for _, b := range budgets {
		if b.Failed() {
			blocked = append(blocked, b.Budget)
		}
	}
	sort.Strings(blocked)

	verdict := model.VerdictPass
	switch {
	case len(blocked) > 0:
		verdict = model.VerdictFail
	case counts[string(model.SeverityError)] > 0 || counts[string(model.SeverityBlocker)] > 0:
		verdict = model.VerdictWarn
	case counts[string(model.SeverityWarning)] > 0:
		verdict = model.VerdictWarn
	}

	s := model.Summary{
		Verdict: verdict, Score: overall, Counts: counts,
		NewFindings: newCount, FixedSince: fixedCount,
		BlockedBy: blocked, Trend: trend,
	}
	if hasBaseline {
		d := scoreDelta
		s.ScoreDelta = &d
	}
	s.Headline = headline(s, budgets, findings, hasBaseline)
	s.NextSteps = nextSteps(s, budgets, findings)
	return s
}

func headline(s model.Summary, budgets []model.BudgetResult, findings []model.Finding, hasBaseline bool) string {
	if len(s.BlockedBy) > 0 {
		for _, b := range budgets {
			if b.Failed() {
				return fmt.Sprintf("Blocked by %s: %s", b.Budget, strings.TrimSuffix(b.Message, "."))
			}
		}
	}
	errs := s.Counts[string(model.SeverityError)] + s.Counts[string(model.SeverityBlocker)]
	switch {
	case errs > 0 && s.NewFindings > 0:
		return fmt.Sprintf("No budget was breached, but this change adds %d new finding(s), %d of them errors.",
			s.NewFindings, errs)
	case errs > 0:
		return fmt.Sprintf("No budget was breached. %d pre-existing error-level finding(s) remain.", errs)
	case s.NewFindings > 0:
		return fmt.Sprintf("Every budget passed. This change adds %d new low-severity finding(s).", s.NewFindings)
	case hasBaseline && s.FixedSince > 0:
		return fmt.Sprintf("Every budget passed, and this change clears %d finding(s) that were there before.", s.FixedSince)
	case len(findings) == 0:
		return "Every budget passed and nothing was flagged."
	default:
		return fmt.Sprintf("Every budget passed. %d finding(s) carried over from before this change.", len(findings))
	}
}

// nextSteps is the platform's answer to "so what do I do now". It is ordered:
// the thing blocking the merge, then the cheapest wins, then the rest.
func nextSteps(s model.Summary, budgets []model.BudgetResult, findings []model.Finding) []string {
	var steps []string
	for _, b := range budgets {
		if b.Failed() {
			steps = append(steps, b.Message)
		}
	}
	auto := 0
	for _, f := range findings {
		if f.Fix.SafeToAutomate && f.New {
			auto++
		}
	}
	if auto > 0 {
		steps = append(steps, fmt.Sprintf(
			"%d of the new findings are marked safe to fix automatically; run `cq fix --safe` or apply each tool's own fixer.", auto))
	}
	if len(steps) == 0 && s.NewFindings > 0 {
		steps = append(steps, "Nothing is blocking. Look at the new findings before they become the baseline.")
	}
	if len(steps) > 5 {
		steps = steps[:5]
	}
	return steps
}

func clamp(v, lo, hi float64) float64 {
	return math.Max(lo, math.Min(hi, v))
}
