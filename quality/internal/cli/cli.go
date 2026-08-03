// Package cli is the command surface. It is deliberately small: a platform
// whose CLI needs a manual is a platform people route around.
//
//	cq run       run the checks and write the reports
//	cq plan      say what would run, and why, without running it
//	cq doctor    check the installation: analyzers, tools, formats, config
//	cq budgets   list the quality gates in force
//	cq explain   explain one finding or one budget in full
//	cq render    re-render an existing report as Markdown or HTML
package cli

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// Version is the platform's own version, stamped at build time with
// -ldflags "-X .../internal/cli.Version=...".
var Version = "dev"

type command struct {
	name    string
	summary string
	run     func(ctx context.Context, args []string, out io.Writer) (int, error)
}

func commands() []command {
	return []command{
		{"run", "run the checks and write the reports", cmdRun},
		{"plan", "say what would run, and why, without running it", cmdPlan},
		{"doctor", "check the installation and the analyzer catalog", cmdDoctor},
		{"budgets", "list the quality gates in force", cmdBudgets},
		{"explain", "explain one finding or one budget in full", cmdExplain},
		{"render", "re-render an existing report as Markdown or HTML", cmdRender},
		{"version", "print the version", cmdVersion},
	}
}

// Main is the entry point. It returns a process exit code: 0 clean, 1 a quality
// gate failed, 2 the platform itself could not finish. Nothing else, so a
// pipeline step can branch on it without parsing anything.
func Main(ctx context.Context, args []string, out, errOut io.Writer) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		usage(out)
		return 0
	}
	for _, c := range commands() {
		if c.name != args[0] {
			continue
		}
		code, err := c.run(ctx, args[1:], out)
		if err != nil {
			fmt.Fprintf(errOut, "cq %s: %v\n", c.name, err)
			if code == 0 {
				code = 2
			}
		}
		return code
	}
	fmt.Fprintf(errOut, "cq: there is no %q command.\n\n", args[0])
	usage(errOut)
	return 2
}

func usage(w io.Writer) {
	fmt.Fprintf(w, "Continuous Quality Platform %s\n\nUsage: cq <command> [flags]\n\n", Version)
	for _, c := range commands() {
		fmt.Fprintf(w, "  %-9s %s\n", c.name, c.summary)
	}
	fmt.Fprintf(w, "\nRun `cq <command> -h` for that command's flags.\n")
	fmt.Fprintf(w, "\nThe usual shapes:\n")
	fmt.Fprintf(w, "  cq run --tier local                    fast feedback while editing\n")
	fmt.Fprintf(w, "  cq run --tier pre-commit --staged      what is about to be committed\n")
	fmt.Fprintf(w, "  cq run --tier pr --base origin/main    everything the change can affect\n")
	fmt.Fprintf(w, "  cq run --tier main --full --baseline   the full sweep, recorded as the new baseline\n")
	fmt.Fprintf(w, "  cq run --only eslint,typescript        re-run just what an agent needs to re-check\n")
}

func cmdVersion(_ context.Context, _ []string, out io.Writer) (int, error) {
	fmt.Fprintf(out, "cq %s (report schema %s)\n", Version, schemaVersion())
	return 0, nil
}

// commonFlags are shared by run and plan.
type commonFlags struct {
	root    string
	tier    string
	base    string
	full    bool
	only    string
	staged  bool
	noCache bool
	jobs    int
}

func (c *commonFlags) bind(fs *flag.FlagSet) {
	fs.StringVar(&c.root, "root", ".", "repository root")
	fs.StringVar(&c.tier, "tier", "pr", "stage to run: local, pre-commit, pr, main, nightly")
	fs.StringVar(&c.base, "base", defaultBase(), "the ref to measure the change against")
	fs.BoolVar(&c.full, "full", false, "run every check for the stage, ignoring what changed")
	fs.StringVar(&c.only, "only", "", "comma-separated analyzer ids to run (plus what they need)")
	fs.BoolVar(&c.staged, "staged", false, "look only at what is staged in git (for a pre-commit hook)")
	fs.BoolVar(&c.noCache, "no-cache", false, "ignore cached analyzer results")
	fs.IntVar(&c.jobs, "jobs", 0, "how many analyzers to run at once (0 means one per CPU)")
}

// defaultBase picks the comparison point from the environment when CI has
// already worked it out, so nobody has to pass it twice.
func defaultBase() string {
	for _, k := range []string{
		"CQ_BASE_REF",
		"GITHUB_BASE_REF",                     // GitHub Actions, pull_request
		"SYSTEM_PULLREQUEST_TARGETBRANCHNAME", // Azure DevOps, PR build
	} {
		if v := os.Getenv(k); v != "" {
			if !strings.Contains(v, "/") {
				return "origin/" + v
			}
			return v
		}
	}
	return ""
}

func splitList(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
