package cli

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/abhijeet-oxide/configer/quality/internal/engine"
	"github.com/abhijeet-oxide/configer/quality/internal/model"
	"github.com/abhijeet-oxide/configer/quality/internal/report"
)

func schemaVersion() string { return model.SchemaVersion }

func cmdRun(ctx context.Context, args []string, out io.Writer) (int, error) {
	var c commonFlags
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(out)
	c.bind(fs)
	saveBaseline := fs.Bool("baseline", false, "record this run as the baseline for the ref it ran on")
	failOn := fs.String("fail-on", "fail", "when to exit non-zero: fail (a budget was breached), warn, or never")
	quiet := fs.Bool("quiet", false, "print only the verdict")
	dryRun := fs.Bool("dry-run", false, "print the commands that would run, and run nothing")
	formats := fs.String("formats", "json,agent,markdown,sarif,junit,html", "which reports to write")
	if err := fs.Parse(args); err != nil {
		return 2, nil
	}

	tier := model.Tier(c.tier)
	if !validTier(tier) {
		return 2, fmt.Errorf("%q is not a stage. Use one of: %s", c.tier, tierList())
	}

	started := time.Now()
	eng, err := engine.New(engine.Options{
		Root: c.root, Tier: tier, BaseRef: c.base, Full: c.full,
		Only: splitList(c.only), NoCache: c.noCache, Parallelism: c.jobs,
		DryRun: *dryRun, Staged: c.staged,
		Progress: func(line string) {
			if !*quiet {
				fmt.Fprintf(out, "  %s\n", line)
			}
		},
	})
	if err != nil {
		return 2, err
	}

	if !*quiet {
		fmt.Fprintf(out, "Continuous Quality Platform, %s stage", tier)
		if c.base != "" {
			fmt.Fprintf(out, ", measured against %s", c.base)
		}
		fmt.Fprintln(out)
	}

	r, err := eng.Run(ctx)
	if err != nil {
		return 2, err
	}

	reportDir := filepath.Join(eng.Opts.Root, eng.Cfg.ReportDir)
	written, err := writeReports(reportDir, r, eng, splitList(*formats))
	if err != nil {
		return 2, err
	}

	if *saveBaseline {
		// Empty means "derive it the same way the read path does", which is the
		// only way the two can be guaranteed to agree.
		ref := engine.BaselineRef(r.Meta.BaseRef, r.Meta.Branch)
		if err := eng.SaveBaseline(r, ref); err != nil {
			fmt.Fprintf(out, "\nThe baseline could not be recorded: %v\n", err)
		} else if !*quiet {
			fmt.Fprintf(out, "\nBaseline recorded for %s.\n", ref)
		}
	}

	// Telemetry is advisory. A collector that is down may not turn a passing
	// quality run into a failing one.
	if err := eng.FlushTelemetry(ctx); err != nil && !*quiet {
		fmt.Fprintf(out, "Telemetry was not delivered: %v\n", err)
	}

	printSummary(out, r, written, time.Since(started), *quiet)

	switch *failOn {
	case "never":
		return 0, nil
	case "warn":
		if r.Summary.Verdict == model.VerdictPass {
			return 0, nil
		}
		return 1, nil
	default:
		return r.ExitCode(), nil
	}
}

// writeReports emits the requested formats and returns what it wrote.
func writeReports(dir string, r *model.Report, eng *engine.Engine, formats []string) ([]string, error) {
	want := map[string]bool{}
	for _, f := range formats {
		want[strings.ToLower(f)] = true
	}
	var written []string
	emit := func(name, path string, fn func() error) error {
		if !want[name] {
			return nil
		}
		if err := fn(); err != nil {
			return fmt.Errorf("writing the %s report: %w", name, err)
		}
		written = append(written, path)
		return nil
	}

	jsonPath := filepath.Join(dir, "report.json")
	if err := emit("json", jsonPath, func() error { return report.WriteJSON(jsonPath, r) }); err != nil {
		return written, err
	}
	agentPath := filepath.Join(dir, "report-agent.json")
	if err := emit("agent", agentPath, func() error {
		return report.WriteAgentJSON(agentPath, r, eng.Cfg.Report)
	}); err != nil {
		return written, err
	}
	mdPath := filepath.Join(dir, "report.md")
	if err := emit("markdown", mdPath, func() error { return report.WriteMarkdown(mdPath, r) }); err != nil {
		return written, err
	}
	sarifPath := filepath.Join(dir, "report.sarif")
	if err := emit("sarif", sarifPath, func() error { return report.WriteSARIF(sarifPath, r) }); err != nil {
		return written, err
	}
	junitPath := filepath.Join(dir, "report.junit.xml")
	if err := emit("junit", junitPath, func() error { return report.WriteJUnit(junitPath, r) }); err != nil {
		return written, err
	}
	htmlPath := filepath.Join(dir, "report.html")
	if err := emit("html", htmlPath, func() error { return report.WriteHTML(htmlPath, r) }); err != nil {
		return written, err
	}
	return written, nil
}

// printSummary is the part a developer actually reads. It says the verdict, the
// reason, and what to do, in that order, and it never asks anybody to open a
// log to find out what happened.
func printSummary(out io.Writer, r *model.Report, written []string, elapsed time.Duration, quiet bool) {
	fmt.Fprintln(out)
	fmt.Fprintf(out, "%s  %s\n", strings.ToUpper(string(r.Summary.Verdict)), r.Summary.Headline)
	fmt.Fprintf(out, "score %d/100", r.Summary.Score)
	if r.Summary.ScoreDelta != nil {
		fmt.Fprintf(out, " (%+d against the baseline)", *r.Summary.ScoreDelta)
	}
	fmt.Fprintf(out, "  |  %d finding(s), %d new  |  %d check(s) in %s\n",
		len(r.Findings), r.Summary.NewFindings, len(r.Analyzers), elapsed.Round(time.Millisecond))

	if fails := r.FailedBudgets(); len(fails) > 0 {
		fmt.Fprintln(out, "\nBudgets that stopped this run:")
		for _, b := range fails {
			fmt.Fprintf(out, "  %-28s %s\n", b.Budget, b.Message)
		}
	}
	if len(r.Errors) > 0 {
		fmt.Fprintln(out, "\nChecks that could not complete (these are platform problems, not code problems):")
		for _, e := range r.Errors {
			fmt.Fprintf(out, "  %s\n", e)
		}
	}
	if len(r.Summary.NextSteps) > 0 {
		fmt.Fprintln(out, "\nNext:")
		for i, s := range r.Summary.NextSteps {
			fmt.Fprintf(out, "  %d. %s\n", i+1, s)
		}
	}
	if !quiet && len(written) > 0 {
		fmt.Fprintln(out, "\nReports:")
		for _, p := range written {
			if rel, err := filepath.Rel(mustWD(), p); err == nil {
				p = rel
			}
			fmt.Fprintf(out, "  %s\n", p)
		}
	}
}

func mustWD() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}

func validTier(t model.Tier) bool {
	for _, x := range model.AllTiers {
		if x == t {
			return true
		}
	}
	return false
}

func tierList() string {
	names := make([]string, 0, len(model.AllTiers))
	for _, t := range model.AllTiers {
		names = append(names, string(t))
	}
	return strings.Join(names, ", ")
}
