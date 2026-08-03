// Package policy is the quality gate. It turns measurements and findings into
// a pass or a fail, and - just as importantly - into a sentence that says why.
//
// The rule the whole package is built around: a failure message must be
// actionable without opening a log. A developer or an agent reading "bundle
// growth: 1.31 MB, was 1.19 MB, +10.1% against main, budget +5%" knows what
// happened, by how much, and what to do. "Quality gate failed" does not.
package policy

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/baseline"
	"github.com/abhijeet-oxide/configer/quality/internal/model"
	"github.com/abhijeet-oxide/configer/quality/internal/spec"
)

// Engine evaluates a repository's budgets.
type Engine struct {
	Cfg      *spec.Config
	Baseline *baseline.Baseline
	Tier     model.Tier
	BaseRef  string
}

// Evaluate runs every applicable budget and returns the results.
func (e Engine) Evaluate(findings []model.Finding, metrics []model.Metric) []model.BudgetResult {
	idx := model.IndexMetrics(metrics)
	var out []model.BudgetResult
	for _, b := range e.Cfg.Budgets {
		if !b.AppliesAt(e.Tier) {
			continue
		}
		if b.Findings != nil {
			out = append(out, e.evaluateFindings(b, findings))
			continue
		}
		matched := idx.MatchKey(b.Metric)
		if len(matched) == 0 {
			out = append(out, model.BudgetResult{
				Budget: b.Name, MetricKey: b.Metric, Category: b.Category,
				Status: model.BudgetSkip, Limit: limitWords(b),
				Message:  fmt.Sprintf("Not measured in this run, so %q was not evaluated.", b.Name),
				Blocking: b.IsBlocking(),
			})
			continue
		}
		sort.Slice(matched, func(i, j int) bool { return matched[i].Key() < matched[j].Key() })
		for _, m := range matched {
			out = append(out, e.evaluateMetric(b, m))
		}
	}
	return out
}

// evaluateMetric applies one budget to one measurement. Absolute limits and
// regression limits are both checked; the worst verdict wins, so a budget can
// carry "never above X" and "never worse than the base branch" at once.
func (e Engine) evaluateMetric(b spec.Budget, m model.Metric) model.BudgetResult {
	res := model.BudgetResult{
		Budget: b.Name, MetricKey: m.Key(), Category: firstCategory(b.Category, m.Category),
		Status: model.BudgetPass, Limit: limitWords(b), Blocking: b.IsBlocking(),
		Analyzer: m.Analyzer,
	}
	v := m.Value
	res.Value = &v

	base, hasBase := e.Baseline.Metric(m.Key())
	if hasBase {
		bv := base
		res.Baseline = &bv
		d := v - base
		res.Delta = &d
		if base != 0 {
			p := d / math.Abs(base) * 100
			res.DeltaPct = &p
		}
	}

	var problems []string
	warn := false

	if b.Max != nil && v > *b.Max {
		problems = append(problems, fmt.Sprintf("%s is %s, over the limit of %s",
			m.Name, m.Format(v), m.Format(*b.Max)))
	} else if b.Max != nil && b.WarnAt != nil && v > *b.WarnAt {
		warn = true
		problems = append(problems, fmt.Sprintf("%s is %s, past the warning line of %s",
			m.Name, m.Format(v), m.Format(*b.WarnAt)))
	}
	if b.Min != nil && v < *b.Min {
		problems = append(problems, fmt.Sprintf("%s is %s, under the required %s",
			m.Name, m.Format(v), m.Format(*b.Min)))
	} else if b.Min != nil && b.WarnAt != nil && v < *b.WarnAt {
		warn = true
		problems = append(problems, fmt.Sprintf("%s is %s, under the target of %s",
			m.Name, m.Format(v), m.Format(*b.WarnAt)))
	}

	if hasBase {
		delta := v - base
		var pct float64
		if base != 0 {
			pct = delta / math.Abs(base) * 100
		}
		against := e.againstWords()
		if b.MaxIncrease != nil && delta > *b.MaxIncrease {
			problems = append(problems, fmt.Sprintf("%s grew by %s%s (now %s, was %s), and the budget allows %s",
				m.Name, m.Format(delta), against, m.Format(v), m.Format(base), m.Format(*b.MaxIncrease)))
		}
		if b.MaxIncreasePct != nil && pct > *b.MaxIncreasePct {
			problems = append(problems, fmt.Sprintf("%s grew %.1f%%%s (now %s, was %s), and the budget allows %.1f%%",
				m.Name, pct, against, m.Format(v), m.Format(base), *b.MaxIncreasePct))
		} else if b.MaxIncreasePct != nil && b.WarnAt != nil && pct > *b.WarnAt {
			warn = true
			problems = append(problems, fmt.Sprintf("%s grew %.1f%%%s (now %s, was %s); the budget is %.1f%%",
				m.Name, pct, against, m.Format(v), m.Format(base), *b.MaxIncreasePct))
		}
		if b.MaxDecrease != nil && -delta > *b.MaxDecrease {
			problems = append(problems, fmt.Sprintf("%s fell by %s%s (now %s, was %s), and the budget allows a fall of %s",
				m.Name, m.Format(-delta), against, m.Format(v), m.Format(base), m.Format(*b.MaxDecrease)))
		}
		if b.MaxDecreasePct != nil && -pct > *b.MaxDecreasePct {
			problems = append(problems, fmt.Sprintf("%s fell %.1f%%%s (now %s, was %s), and the budget allows %.1f%%",
				m.Name, -pct, against, m.Format(v), m.Format(base), *b.MaxDecreasePct))
		}
	} else if needsBaseline(b) {
		// A regression budget with nothing to regress against is a skip, not a
		// pass. Reporting it as a pass would quietly turn the gate off on every
		// new branch, which is exactly when people trust it most.
		res.Status = model.BudgetSkip
		res.Message = fmt.Sprintf("No baseline for %s yet, so %q could not compare against anything.",
			m.Name, b.Name)
		return res
	}

	switch {
	case len(problems) == 0:
		res.Message = fmt.Sprintf("%s: %s", m.Name, m.Format(v))
		if hasBase {
			res.Message += fmt.Sprintf(" (%s%s)", model.TrendOf(m, v, base), e.againstWords())
		}
	case warn && !hasHardBreach(b, m, v, base, hasBase):
		res.Status = model.BudgetWarn
		res.Message = problems[0]
	default:
		res.Status = model.BudgetFail
		res.Message = strings.Join(problems, "; ")
	}
	if m.Subject != "" {
		res.Message = m.Subject + ": " + res.Message
	}
	return res
}

// hasHardBreach re-asks whether a hard limit (not the warning line) was crossed,
// so a budget carrying both does not downgrade a real failure to a warning.
func hasHardBreach(b spec.Budget, m model.Metric, v, base float64, hasBase bool) bool {
	if b.Max != nil && v > *b.Max {
		return true
	}
	if b.Min != nil && v < *b.Min {
		return true
	}
	if !hasBase {
		return false
	}
	delta := v - base
	var pct float64
	if base != 0 {
		pct = delta / math.Abs(base) * 100
	}
	if b.MaxIncrease != nil && delta > *b.MaxIncrease {
		return true
	}
	if b.MaxIncreasePct != nil && pct > *b.MaxIncreasePct {
		return true
	}
	if b.MaxDecrease != nil && -delta > *b.MaxDecrease {
		return true
	}
	if b.MaxDecreasePct != nil && -pct > *b.MaxDecreasePct {
		return true
	}
	return false
}

// evaluateFindings applies a budget that counts findings rather than measuring.
func (e Engine) evaluateFindings(b spec.Budget, findings []model.Finding) model.BudgetResult {
	sel := *b.Findings
	var matched []model.Finding
	for _, f := range findings {
		if sel.Category != "" && f.Category != sel.Category {
			continue
		}
		if sel.MinSeverity != "" && !f.Severity.AtLeast(sel.MinSeverity) {
			continue
		}
		if sel.Analyzer != "" && !hasTool(f, sel.Analyzer) {
			continue
		}
		if sel.Tag != "" && !hasTag(f, sel.Tag) {
			continue
		}
		if sel.OnlyNew && !f.New {
			continue
		}
		matched = append(matched, f)
	}
	n := float64(len(matched))
	res := model.BudgetResult{
		Budget: b.Name, MetricKey: selectorWords(sel), Category: firstCategory(b.Category, sel.Category),
		Status: model.BudgetPass, Value: &n, Limit: limitWords(b), Blocking: b.IsBlocking(),
	}
	if b.Max != nil && n > *b.Max {
		res.Status = model.BudgetFail
		res.Message = fmt.Sprintf("%.0f %s, and the budget allows %.0f. %s",
			n, selectorWords(sel), *b.Max, namesOf(matched, 3))
	} else if b.Max != nil && b.WarnAt != nil && n > *b.WarnAt {
		res.Status = model.BudgetWarn
		res.Message = fmt.Sprintf("%.0f %s (warning line %.0f).", n, selectorWords(sel), *b.WarnAt)
	} else {
		res.Message = fmt.Sprintf("%.0f %s.", n, selectorWords(sel))
	}
	return res
}

func (e Engine) againstWords() string {
	if e.BaseRef == "" {
		return " against the last recorded run"
	}
	return " against " + e.BaseRef
}

func needsBaseline(b spec.Budget) bool {
	return b.MaxIncrease != nil || b.MaxIncreasePct != nil ||
		b.MaxDecrease != nil || b.MaxDecreasePct != nil
}

func limitWords(b spec.Budget) string {
	var parts []string
	if b.Max != nil {
		parts = append(parts, fmt.Sprintf("at most %g", *b.Max))
	}
	if b.Min != nil {
		parts = append(parts, fmt.Sprintf("at least %g", *b.Min))
	}
	if b.MaxIncrease != nil {
		parts = append(parts, fmt.Sprintf("growth of at most %g", *b.MaxIncrease))
	}
	if b.MaxIncreasePct != nil {
		parts = append(parts, fmt.Sprintf("growth of at most %g%%", *b.MaxIncreasePct))
	}
	if b.MaxDecrease != nil {
		parts = append(parts, fmt.Sprintf("a fall of at most %g", *b.MaxDecrease))
	}
	if b.MaxDecreasePct != nil {
		parts = append(parts, fmt.Sprintf("a fall of at most %g%%", *b.MaxDecreasePct))
	}
	return strings.Join(parts, ", ")
}

func selectorWords(s spec.FindingSelector) string {
	var parts []string
	if s.OnlyNew {
		parts = append(parts, "new")
	}
	if s.MinSeverity != "" {
		parts = append(parts, string(s.MinSeverity)+"-or-worse")
	}
	if s.Category != "" {
		parts = append(parts, string(s.Category))
	}
	if s.Tag != "" {
		parts = append(parts, s.Tag)
	}
	parts = append(parts, "findings")
	return strings.Join(parts, " ")
}

func namesOf(fs []model.Finding, n int) string {
	if len(fs) == 0 {
		return ""
	}
	var out []string
	for i, f := range fs {
		if i >= n {
			out = append(out, fmt.Sprintf("and %d more", len(fs)-n))
			break
		}
		where := f.PrimaryPath()
		if where == "" {
			out = append(out, f.Title)
		} else {
			out = append(out, fmt.Sprintf("%s (%s)", f.Title, where))
		}
	}
	return "First: " + strings.Join(out, "; ") + "."
}

func hasTool(f model.Finding, id string) bool {
	if f.Analyzer == id {
		return true
	}
	for _, t := range f.Tools {
		if t == id {
			return true
		}
	}
	return false
}

func hasTag(f model.Finding, tag string) bool {
	for _, t := range f.Tags {
		if strings.EqualFold(t, tag) {
			return true
		}
	}
	return false
}

func firstCategory(cs ...model.Category) model.Category {
	for _, c := range cs {
		if c != "" {
			return c
		}
	}
	return model.CategoryGeneral
}
