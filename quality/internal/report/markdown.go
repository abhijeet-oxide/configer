package report

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

// WriteMarkdown renders the pull-request summary. It is written for somebody
// who has thirty seconds: verdict, why, what to do, and only then the detail.
// It never quotes a log and never explains anything in terms of git or CI
// internals.
func WriteMarkdown(path string, r *model.Report) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(Markdown(r)), 0o644)
}

// Markdown renders the report as GitHub-flavoured Markdown.
func Markdown(r *model.Report) string {
	var b strings.Builder

	fmt.Fprintf(&b, "## %s Quality report\n\n", verdictMark(r.Summary.Verdict))
	fmt.Fprintf(&b, "**%s**\n\n", r.Summary.Headline)

	fmt.Fprintf(&b, "| | |\n|---|---|\n")
	fmt.Fprintf(&b, "| Verdict | **%s** |\n", strings.ToUpper(string(r.Summary.Verdict)))
	fmt.Fprintf(&b, "| Score | %d / 100%s |\n", r.Summary.Score, deltaWords(r.Summary.ScoreDelta))
	fmt.Fprintf(&b, "| Stage | %s |\n", r.Selection.Tier)
	fmt.Fprintf(&b, "| Checks run | %d of %d (%d changed file(s), %s) |\n",
		len(r.Selection.Selected), len(r.Selection.Selected)+len(r.Selection.Skipped),
		r.Selection.ChangedFiles, scopeWords(r.Selection.Scopes))
	fmt.Fprintf(&b, "| Findings | %s |\n", countWords(r.Summary.Counts))
	if r.Summary.NewFindings > 0 || r.Summary.FixedSince > 0 {
		fmt.Fprintf(&b, "| Against the base | %d new, %d cleared |\n",
			r.Summary.NewFindings, r.Summary.FixedSince)
	}
	fmt.Fprintf(&b, "| Time | %s (%d cached) |\n", duration(r.Meta.DurationMS), r.Meta.CacheHits)
	b.WriteString("\n")

	if steps := r.Summary.NextSteps; len(steps) > 0 {
		b.WriteString("### What to do next\n\n")
		for _, s := range steps {
			fmt.Fprintf(&b, "1. %s\n", s)
		}
		b.WriteString("\n")
	}

	// Budgets come before findings: the gate is what decides the merge, and a
	// reader who stops here has read the part that matters.
	if len(r.Budgets) > 0 {
		b.WriteString("### Quality budgets\n\n")
		b.WriteString("| Budget | Status | Measured | Baseline | Change | Rule |\n")
		b.WriteString("|---|---|---|---|---|---|\n")
		for _, bd := range r.Budgets {
			if bd.Status == model.BudgetSkip {
				continue
			}
			fmt.Fprintf(&b, "| %s | %s | %s | %s | %s | %s |\n",
				bd.Budget, budgetMark(bd), num(bd.Value), num(bd.Baseline),
				changeWords(bd), bd.Limit)
		}
		if skipped := skippedBudgets(r); len(skipped) > 0 {
			fmt.Fprintf(&b, "\n<sub>Not evaluated this run (nothing measured them): %s</sub>\n",
				strings.Join(skipped, ", "))
		}
		b.WriteString("\n")
	}

	if len(r.Categories) > 0 {
		b.WriteString("### By area\n\n| Area | Score | Findings | Verdict |\n|---|---|---|---|\n")
		for _, c := range r.Categories {
			fmt.Fprintf(&b, "| %s | %d | %d | %s |\n",
				title(string(c.Category)), c.Score, c.Findings, verdictMark(c.Verdict))
		}
		b.WriteString("\n")
	}

	writeFindings(&b, r)

	if len(r.Artifacts) > 0 {
		b.WriteString("<details><summary>Artifacts</summary>\n\n")
		for _, a := range r.Artifacts {
			fmt.Fprintf(&b, "- `%s` (%s)\n", a.Path, a.Kind)
		}
		b.WriteString("\n</details>\n\n")
	}

	writeAnalyzerTable(&b, r)

	if len(r.Errors) > 0 {
		b.WriteString("### The platform itself had trouble\n\n")
		for _, e := range r.Errors {
			fmt.Fprintf(&b, "- %s\n", e)
		}
		b.WriteString("\nThese are problems with the checks, not with the code under review.\n\n")
	}
	fmt.Fprintf(&b, "<sub>Continuous Quality Platform, schema %s, run %s</sub>\n",
		r.Schema, r.Meta.ID)
	return b.String()
}

func writeFindings(b *strings.Builder, r *model.Report) {
	if len(r.Findings) == 0 {
		return
	}
	var newOnes, rest []model.Finding
	for _, f := range r.Findings {
		if f.New {
			newOnes = append(newOnes, f)
		} else {
			rest = append(rest, f)
		}
	}
	if len(newOnes) > 0 {
		b.WriteString("### New in this change\n\n")
		writeFindingList(b, newOnes, 15)
	}
	if len(rest) > 0 {
		fmt.Fprintf(b, "<details><summary>Pre-existing findings (%d)</summary>\n\n", len(rest))
		writeFindingList(b, rest, 25)
		b.WriteString("</details>\n\n")
	}
}

func writeFindingList(b *strings.Builder, fs []model.Finding, limit int) {
	for i, f := range fs {
		if i >= limit {
			fmt.Fprintf(b, "\n_...and %d more. The full set is in the JSON and SARIF artifacts._\n\n", len(fs)-limit)
			return
		}
		where := ""
		if len(f.Where) > 0 {
			where = " `" + f.Where[0].String() + "`"
		}
		auto := ""
		if f.Fix.SafeToAutomate {
			auto = " _(safe to fix automatically)_"
		}
		fmt.Fprintf(b, "- **%s** %s%s%s\n", severityMark(f.Severity), f.Title, where, auto)
		if f.Fix.Recommendation != "" {
			fmt.Fprintf(b, "  - %s\n", f.Fix.Recommendation)
		}
		if len(f.Tools) > 1 {
			fmt.Fprintf(b, "  - <sub>Reported independently by %s</sub>\n", strings.Join(f.Tools, " and "))
		}
	}
	b.WriteString("\n")
}

func writeAnalyzerTable(b *strings.Builder, r *model.Report) {
	if len(r.Analyzers) == 0 {
		return
	}
	b.WriteString("<details><summary>What ran</summary>\n\n")
	b.WriteString("| Check | Status | Time | Cached | Findings |\n|---|---|---|---|---|\n")
	sorted := append([]model.AnalyzerRun(nil), r.Analyzers...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].DurationMS > sorted[j].DurationMS })
	for _, a := range sorted {
		cached := ""
		if a.CacheHit {
			cached = "yes"
		}
		status := a.Status
		if a.Reason != "" {
			status += " (" + a.Reason + ")"
		}
		fmt.Fprintf(b, "| %s | %s | %s | %s | %d |\n",
			a.ID, status, duration(a.DurationMS), cached, a.Findings)
	}
	if len(r.Selection.Skipped) > 0 {
		fmt.Fprintf(b, "\nNot run: %s\n", strings.Join(r.Selection.Skipped, ", "))
	}
	b.WriteString("\n</details>\n\n")
}

func skippedBudgets(r *model.Report) []string {
	var out []string
	for _, b := range r.Budgets {
		if b.Status == model.BudgetSkip {
			out = append(out, b.Budget)
		}
	}
	sort.Strings(out)
	return out
}

func verdictMark(v model.Verdict) string {
	switch v {
	case model.VerdictPass:
		return "PASS"
	case model.VerdictWarn:
		return "WARN"
	case model.VerdictFail:
		return "FAIL"
	default:
		return "ERROR"
	}
}

func budgetMark(b model.BudgetResult) string {
	switch b.Status {
	case model.BudgetPass:
		return "pass"
	case model.BudgetWarn:
		return "warn"
	case model.BudgetFail:
		if !b.Blocking {
			return "**fail** (advisory)"
		}
		return "**FAIL**"
	default:
		return "not measured"
	}
}

func severityMark(s model.Severity) string {
	return strings.ToUpper(string(s))
}

func num(v *float64) string {
	if v == nil {
		return "-"
	}
	if *v == float64(int64(*v)) {
		return fmt.Sprintf("%d", int64(*v))
	}
	return fmt.Sprintf("%.2f", *v)
}

func changeWords(b model.BudgetResult) string {
	if b.DeltaPct == nil {
		if b.Delta == nil {
			return "-"
		}
		return fmt.Sprintf("%+.2f", *b.Delta)
	}
	return fmt.Sprintf("%+.1f%%", *b.DeltaPct)
}

func deltaWords(d *int) string {
	if d == nil {
		return ""
	}
	if *d == 0 {
		return " (unchanged)"
	}
	return fmt.Sprintf(" (%+d)", *d)
}

func countWords(counts map[string]int) string {
	order := []model.Severity{model.SeverityBlocker, model.SeverityError, model.SeverityWarning, model.SeverityNote}
	var parts []string
	for _, s := range order {
		if n := counts[string(s)]; n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", n, s))
		}
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, ", ")
}

func scopeWords(scopes []string) string {
	if len(scopes) == 0 {
		return "nothing changed"
	}
	return strings.Join(scopes, " + ")
}

func duration(ms int64) string {
	switch {
	case ms < 1000:
		return fmt.Sprintf("%dms", ms)
	case ms < 60000:
		return fmt.Sprintf("%.1fs", float64(ms)/1000)
	default:
		return fmt.Sprintf("%dm %ds", ms/60000, (ms%60000)/1000)
	}
}

func title(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
