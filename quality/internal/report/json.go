// Package report writes the run out in the formats its readers need: JSON for
// agents and dashboards, Markdown for a pull request, SARIF for the code
// scanning tab, JUnit for the test panel, HTML for a person.
//
// The JSON report is the primary one. Everything else is a projection of it.
package report

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
	"github.com/abhijeet-oxide/configer/quality/internal/spec"
)

// WriteJSON emits the full report: every finding, every metric, every analyzer.
// This is the archive and the dashboard's input.
func WriteJSON(path string, r *model.Report) error {
	return writeJSONFile(path, r)
}

// WriteAgentJSON emits the report an AI agent should read.
//
// This function is where most of the platform's token economy lives, so its
// choices are worth stating plainly. Against the full report it:
//
//   - drops everything below the configured severity floor,
//   - drops findings that were already in the baseline when newOnly is set,
//     because a change is answerable for what it added,
//   - caps the total and the per-analyzer count, so one noisy linter cannot
//     crowd out the security scanner,
//   - truncates evidence to a quotation,
//   - drops the per-analyzer timing table, which is operator data, not agent
//     data, and
//   - never inlines a log. Artifacts are paths.
//
// Nothing is lost: the full JSON and the SARIF sit next to it. What is dropped
// is dropped from the thing an agent reads on every iteration of a fix loop.
func WriteAgentJSON(path string, r *model.Report, opt spec.ReportOptions) error {
	slim := *r
	slim.Analyzers = nil
	slim.Metrics = trimMetrics(r)

	findings := make([]model.Finding, 0, len(r.Findings))
	perAnalyzer := map[string]int{}
	dropped := 0
	for _, f := range r.Findings {
		if opt.MinSeverity != "" && !f.Severity.AtLeast(opt.MinSeverity) {
			dropped++
			continue
		}
		if opt.NewOnly && !f.New {
			dropped++
			continue
		}
		if opt.MaxPerAnalyzer > 0 && perAnalyzer[f.Analyzer] >= opt.MaxPerAnalyzer {
			dropped++
			continue
		}
		if opt.MaxFindings > 0 && len(findings) >= opt.MaxFindings {
			dropped++
			continue
		}
		perAnalyzer[f.Analyzer]++
		f.Evidence = clip(f.Evidence, opt.EvidenceChars)
		f.Detail = clip(f.Detail, 240)
		// Some rulesets write several paragraphs of help text. An agent needs
		// the instruction, not the essay, and the full text is in the SARIF and
		// behind `cq explain`. Semgrep findings alone were 2 KB each without
		// this.
		f.Fix.Recommendation = clip(f.Fix.Recommendation, 240)
		// Locations past the first few add bytes without adding a decision: an
		// agent opens the first one. The full report keeps up to eight.
		if len(f.Where) > 3 {
			f.Where = f.Where[:3]
		}
		findings = append(findings, f)
	}
	slim.Findings = findings

	// Truncation that is not declared is a lie. If the agent is reading a
	// subset, the summary says so and says how to get the rest.
	if dropped > 0 {
		slim.Summary.NextSteps = append(slim.Summary.NextSteps, fmt.Sprintf(
			"%d further finding(s) were left out of this view; the complete set is in %s and in the SARIF artifact.",
			dropped, filepath.Base(strings.TrimSuffix(path, "-agent.json")+".json")))
	}
	return writeJSONFile(path, &slim)
}

// trimMetrics keeps the metrics an agent can act on and drops the long tail of
// per-subject measurements that only a dashboard wants. A metric that a budget
// references always survives, whatever else goes.
func trimMetrics(r *model.Report) []model.Metric {
	referenced := map[string]bool{}
	for _, b := range r.Budgets {
		referenced[b.MetricKey] = true
	}
	out := make([]model.Metric, 0, len(r.Metrics))
	perID := map[string]int{}
	for _, m := range r.Metrics {
		if referenced[m.Key()] {
			out = append(out, m)
			continue
		}
		if perID[m.ID] >= 3 {
			continue
		}
		perID[m.ID]++
		out = append(out, m)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Key() < out[j].Key() })
	return out
}

func writeJSONFile(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func clip(s string, n int) string {
	if n <= 0 || len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
