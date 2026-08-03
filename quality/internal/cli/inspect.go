package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/catalog"
	"github.com/abhijeet-oxide/configer/quality/internal/engine"
	"github.com/abhijeet-oxide/configer/quality/internal/model"
	"github.com/abhijeet-oxide/configer/quality/internal/normalize"
	"github.com/abhijeet-oxide/configer/quality/internal/report"
	"github.com/abhijeet-oxide/configer/quality/internal/runner"
	"github.com/abhijeet-oxide/configer/quality/internal/spec"
)

// cmdPlan prints the selection decision. This command exists because a platform
// that silently decides not to run something is a platform nobody believes:
// "why didn't the accessibility check run on my PR" has to have an answer that
// takes one command and no log reading.
func cmdPlan(ctx context.Context, args []string, out io.Writer) (int, error) {
	var c commonFlags
	fs := flag.NewFlagSet("plan", flag.ContinueOnError)
	fs.SetOutput(out)
	c.bind(fs)
	asJSON := fs.Bool("json", false, "emit the plan as JSON")
	if err := fs.Parse(args); err != nil {
		return 2, nil
	}
	eng, err := engine.New(engine.Options{
		Root: c.root, Tier: model.Tier(c.tier), BaseRef: c.base,
		Full: c.full, Only: splitList(c.only), Staged: c.staged,
	})
	if err != nil {
		return 2, err
	}
	p, err := eng.Plan(ctx)
	if err != nil {
		return 2, err
	}
	if *asJSON {
		return 0, json.NewEncoder(out).Encode(map[string]any{
			"tier": p.Tier, "baseRef": p.BaseRef, "scopes": p.Scopes,
			"changedFiles": p.ChangedPaths, "selected": p.SelectedIDs(),
			"skipped": p.SkippedIDs(),
		})
	}

	fmt.Fprintf(out, "Stage:         %s\n", p.Tier)
	if p.BaseRef != "" {
		fmt.Fprintf(out, "Measured from: %s\n", p.BaseRef)
	}
	fmt.Fprintf(out, "Changed:       %d file(s)\n", len(p.ChangedPaths))
	fmt.Fprintf(out, "Areas:         %s\n", strings.Join(p.Scopes, ", "))
	if len(p.ChangedPaths) > 0 && len(p.ChangedPaths) <= 20 {
		for _, f := range p.ChangedPaths {
			fmt.Fprintf(out, "               %s\n", f)
		}
	}

	fmt.Fprintf(out, "\nWill run (%d):\n", len(p.Selected))
	for _, a := range p.Selected {
		fmt.Fprintf(out, "  %-28s %-14s %-9s %s\n", a.ID, a.Category, a.Cost, a.Name)
	}
	if len(p.Skipped) > 0 {
		fmt.Fprintf(out, "\nWill not run (%d):\n", len(p.Skipped))
		for _, s := range p.Skipped {
			fmt.Fprintf(out, "  %-28s %s\n", s.ID, s.Reason)
		}
	}
	return 0, nil
}

// cmdDoctor is the installation check. It answers, in one screen: is the
// configuration valid, is every manifest well formed, does every declared
// output format exist, and which tools are actually present on this machine.
func cmdDoctor(ctx context.Context, args []string, out io.Writer) (int, error) {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	fs.SetOutput(out)
	root := fs.String("root", ".", "repository root")
	if err := fs.Parse(args); err != nil {
		return 2, nil
	}
	abs, _ := filepath.Abs(*root)

	cfg, err := spec.Load(abs)
	if err != nil {
		fmt.Fprintf(out, "Configuration: INVALID\n  %v\n", err)
		return 2, nil
	}
	source := cfg.Path
	if source == "" {
		source = "built-in defaults (no cq.yaml in this repository)"
	}
	fmt.Fprintf(out, "Configuration: %s\n", source)
	fmt.Fprintf(out, "  budgets:   %d\n  scopes:    %s\n  artifacts: %s\n  cache:     %s\n",
		len(cfg.Budgets), strings.Join(scopeNames(cfg), ", "), cfg.ArtifactDir, cfg.CacheDir)

	cat, err := catalog.Load(abs, cfg)
	if err != nil {
		return 2, err
	}
	fmt.Fprintf(out, "\nAnalyzers: %d loaded", len(cat.Analyzers))
	if n := len(cat.Analyzers) - len(cat.Enabled()); n > 0 {
		fmt.Fprintf(out, " (%d disabled)", n)
	}
	fmt.Fprintln(out)
	for _, p := range cat.Problems {
		fmt.Fprintf(out, "  PROBLEM  %s\n", p)
	}

	// An unknown output format is the one manifest mistake that produces a
	// confusing runtime failure rather than an obvious one, so it is checked
	// here before anything runs.
	for _, a := range cat.Analyzers {
		if _, ok := normalize.Get(a.Output.Format); !ok {
			fmt.Fprintf(out, "  PROBLEM  %s declares output format %q, which no normalizer reads. Known: %s\n",
				a.ID, a.Output.Format, strings.Join(normalize.Formats(), ", "))
		}
	}

	fmt.Fprintf(out, "\nTools on this machine:\n")
	run := &runner.Runner{Root: abs, ArtifactDir: filepath.Join(abs, cfg.ArtifactDir), Tier: model.TierLocal}
	missing, optional := 0, 0
	for _, a := range cat.Enabled() {
		version, ok := run.Probe(ctx, a)
		switch {
		case ok:
			fmt.Fprintf(out, "  ok       %-26s %s\n", a.ID, version)
		case a.Tool.Optional:
			optional++
			fmt.Fprintf(out, "  absent   %-26s optional. %s\n", a.ID, a.Tool.Install)
		default:
			missing++
			fmt.Fprintf(out, "  MISSING  %-26s %s\n", a.ID, a.Tool.Install)
		}
	}

	fmt.Fprintf(out, "\nOutput formats understood: %s\n", strings.Join(normalize.Formats(), ", "))
	fmt.Fprintf(out, "\n%d tool(s) missing, %d optional tool(s) absent.\n", missing, optional)
	if missing > 0 {
		fmt.Fprintln(out, "A missing tool means its checks are skipped and named in the report, never silently passed.")
	}
	if len(cat.Problems) > 0 {
		return 1, nil
	}
	return 0, nil
}

func scopeNames(cfg *spec.Config) []string {
	out := make([]string, 0, len(cfg.Scopes))
	for k := range cfg.Scopes {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// cmdBudgets lists the gates in force, which is the document a team argues
// about when they disagree about what "good" means here.
func cmdBudgets(_ context.Context, args []string, out io.Writer) (int, error) {
	fs := flag.NewFlagSet("budgets", flag.ContinueOnError)
	fs.SetOutput(out)
	root := fs.String("root", ".", "repository root")
	asJSON := fs.Bool("json", false, "emit the budgets as JSON")
	if err := fs.Parse(args); err != nil {
		return 2, nil
	}
	abs, _ := filepath.Abs(*root)
	cfg, err := spec.Load(abs)
	if err != nil {
		return 2, err
	}
	if *asJSON {
		return 0, json.NewEncoder(out).Encode(cfg.Budgets)
	}
	fmt.Fprintf(out, "%-28s %-9s %-11s %s\n", "BUDGET", "BLOCKING", "STAGES", "RULE")
	for _, b := range cfg.Budgets {
		blocking := "advisory"
		if b.IsBlocking() {
			blocking = "blocking"
		}
		stages := "all"
		if len(b.Tiers) > 0 {
			var ts []string
			for _, t := range b.Tiers {
				ts = append(ts, string(t))
			}
			stages = strings.Join(ts, "+")
		}
		subject := b.Metric
		if b.Findings != nil {
			subject = "findings"
		}
		fmt.Fprintf(out, "%-28s %-9s %-11s %s %s\n", b.Name, blocking, stages, subject, ruleWords(b))
	}
	fmt.Fprintf(out, "\n%d budgets. A blocking budget fails the build; an advisory one is measured and reported.\n",
		len(cfg.Budgets))
	return 0, nil
}

func ruleWords(b spec.Budget) string {
	var parts []string
	if b.Max != nil {
		parts = append(parts, fmt.Sprintf("<= %g", *b.Max))
	}
	if b.Min != nil {
		parts = append(parts, fmt.Sprintf(">= %g", *b.Min))
	}
	if b.MaxIncreasePct != nil {
		parts = append(parts, fmt.Sprintf("growth <= %g%%", *b.MaxIncreasePct))
	}
	if b.MaxIncrease != nil {
		parts = append(parts, fmt.Sprintf("growth <= %g", *b.MaxIncrease))
	}
	if b.MaxDecreasePct != nil {
		parts = append(parts, fmt.Sprintf("fall <= %g%%", *b.MaxDecreasePct))
	}
	if b.MaxDecrease != nil {
		parts = append(parts, fmt.Sprintf("fall <= %g", *b.MaxDecrease))
	}
	return strings.Join(parts, ", ")
}

// cmdExplain expands one finding or one budget from an existing report. It is
// the escape hatch that keeps the agent-facing report small: an agent reads 40
// compact findings, then asks for the whole of the one it is about to fix.
func cmdExplain(_ context.Context, args []string, out io.Writer) (int, error) {
	fs := flag.NewFlagSet("explain", flag.ContinueOnError)
	fs.SetOutput(out)
	reportPath := fs.String("report", ".cq/report.json", "the report to read")
	if err := fs.Parse(args); err != nil {
		return 2, nil
	}
	if fs.NArg() == 0 {
		return 2, fmt.Errorf("say what to explain: a finding id or a budget name")
	}
	target := fs.Arg(0)

	b, err := os.ReadFile(*reportPath)
	if err != nil {
		return 2, fmt.Errorf("no report at %s. Run `cq run` first", *reportPath)
	}
	var r model.Report
	if err := json.Unmarshal(b, &r); err != nil {
		return 2, err
	}

	for _, f := range r.Findings {
		if f.Fingerprint != target && !strings.HasPrefix(f.Fingerprint, target) {
			continue
		}
		fmt.Fprintf(out, "%s\n\n", f.Title)
		fmt.Fprintf(out, "  id           %s\n  severity     %s\n  confidence   %s\n",
			f.Fingerprint, f.Severity, f.Conf)
		fmt.Fprintf(out, "  category     %s\n  rule         %s\n  reported by  %s\n",
			f.Category, f.Rule, strings.Join(f.Tools, ", "))
		if f.New {
			fmt.Fprintln(out, "  status       new in this change")
		}
		for _, l := range f.Where {
			fmt.Fprintf(out, "  where        %s %s\n", l.String(), l.Symbol)
		}
		if f.Detail != "" {
			fmt.Fprintf(out, "\n%s\n", f.Detail)
		}
		if f.Evidence != "" {
			fmt.Fprintf(out, "\nEvidence:\n  %s\n", f.Evidence)
		}
		fmt.Fprintf(out, "\nRecommended fix (%s effort, %s to automate):\n  %s\n",
			orDash(f.Fix.Effort), yesNo(f.Fix.SafeToAutomate), f.Fix.Recommendation)
		if f.Fix.DocsURL != "" {
			fmt.Fprintf(out, "\n  %s\n", f.Fix.DocsURL)
		}
		return 0, nil
	}

	for _, bd := range r.Budgets {
		if bd.Budget != target {
			continue
		}
		fmt.Fprintf(out, "%s: %s\n\n%s\n\n", bd.Budget, strings.ToUpper(string(bd.Status)), bd.Message)
		fmt.Fprintf(out, "  metric    %s\n  rule      %s\n  blocking  %s\n",
			bd.MetricKey, bd.Limit, yesNo(bd.Blocking))
		if bd.Value != nil {
			fmt.Fprintf(out, "  measured  %v\n", *bd.Value)
		}
		if bd.Baseline != nil {
			fmt.Fprintf(out, "  baseline  %v\n", *bd.Baseline)
		}
		return 0, nil
	}
	return 1, fmt.Errorf("no finding or budget in %s matches %q", *reportPath, target)
}

// cmdRender re-derives the human formats from a stored report, so a CI job can
// produce the JSON once and a later job can turn it into a PR comment without
// re-running anything.
func cmdRender(_ context.Context, args []string, out io.Writer) (int, error) {
	fs := flag.NewFlagSet("render", flag.ContinueOnError)
	fs.SetOutput(out)
	format := fs.String("format", "markdown", "markdown, html, sarif or junit")
	outPath := fs.String("out", "", "where to write it (default: stdout for markdown)")
	if err := fs.Parse(args); err != nil {
		return 2, nil
	}
	path := ".cq/report.json"
	if fs.NArg() > 0 {
		path = fs.Arg(0)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return 2, err
	}
	var r model.Report
	if err := json.Unmarshal(b, &r); err != nil {
		return 2, err
	}
	switch *format {
	case "markdown", "md":
		if *outPath == "" {
			fmt.Fprint(out, report.Markdown(&r))
			return 0, nil
		}
		return 0, report.WriteMarkdown(*outPath, &r)
	case "html":
		if *outPath == "" {
			*outPath = ".cq/report.html"
		}
		return 0, report.WriteHTML(*outPath, &r)
	case "sarif":
		if *outPath == "" {
			*outPath = ".cq/report.sarif"
		}
		return 0, report.WriteSARIF(*outPath, &r)
	case "junit":
		if *outPath == "" {
			*outPath = ".cq/report.junit.xml"
		}
		return 0, report.WriteJUnit(*outPath, &r)
	default:
		return 2, fmt.Errorf("%q is not a format. Use markdown, html, sarif or junit", *format)
	}
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

func orDash(s string) string {
	if s == "" {
		return "unknown"
	}
	return s
}
