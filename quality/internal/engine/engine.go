// Package engine is the orchestrator: it discovers analyzers, decides which to
// run, runs them, normalizes what they said, deduplicates it, scores it,
// applies the budgets and hands back one report.
//
// Everything it does is boring on purpose. The interesting decisions live in
// the packages it calls, and the value of this one is that they happen in the
// right order, exactly once, with the failures of any single analyzer contained.
package engine

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/abhijeet-oxide/configer/quality/internal/baseline"
	"github.com/abhijeet-oxide/configer/quality/internal/cache"
	"github.com/abhijeet-oxide/configer/quality/internal/catalog"
	"github.com/abhijeet-oxide/configer/quality/internal/dedupe"
	"github.com/abhijeet-oxide/configer/quality/internal/impact"
	"github.com/abhijeet-oxide/configer/quality/internal/model"
	"github.com/abhijeet-oxide/configer/quality/internal/normalize"
	"github.com/abhijeet-oxide/configer/quality/internal/policy"
	"github.com/abhijeet-oxide/configer/quality/internal/runner"
	"github.com/abhijeet-oxide/configer/quality/internal/score"
	"github.com/abhijeet-oxide/configer/quality/internal/spec"
	"github.com/abhijeet-oxide/configer/quality/internal/telemetry"
)

// Options are one invocation's parameters.
type Options struct {
	Root        string
	Tier        model.Tier
	BaseRef     string
	Full        bool
	Only        []string
	NoCache     bool
	Parallelism int
	DryRun      bool
	// Staged restricts the diff to the git index, which is what a pre-commit
	// hook must look at: the working tree may contain work the developer
	// deliberately did not stage.
	Staged bool
	// Progress receives one line per analyzer as it completes. Nil is silent.
	Progress func(string)
}

// Engine holds everything a run needs, loaded once.
type Engine struct {
	Opts    Options
	Cfg     *spec.Config
	Catalog *catalog.Catalog
	Tracer  *telemetry.Tracer
	cache   *cache.Cache
	git     impact.Git
}

// New loads configuration and the analyzer catalog.
func New(opts Options) (*Engine, error) {
	root, err := filepath.Abs(opts.Root)
	if err != nil {
		return nil, err
	}
	opts.Root = root

	cfg, err := spec.Load(root)
	if err != nil {
		return nil, err
	}
	cat, err := catalog.Load(root, cfg)
	if err != nil {
		return nil, err
	}
	if opts.Parallelism > 0 {
		cfg.Parallelism = opts.Parallelism
	}
	if cfg.Parallelism <= 0 {
		cfg.Parallelism = runtime.NumCPU()
	}
	return &Engine{
		Opts: opts, Cfg: cfg, Catalog: cat,
		Tracer: telemetry.New(cfg.Telemetry.ServiceName, cfg.Telemetry.Attributes, cfg.Telemetry.Enabled),
		cache:  cache.Open(filepath.Join(root, cfg.CacheDir), !opts.NoCache),
		git:    impact.NewGit(root),
	}, nil
}

// Plan works out what would run, without running anything.
func (e *Engine) Plan(ctx context.Context) (impact.Plan, error) {
	var changes []impact.Change
	var base string
	var err error
	if e.Opts.Staged {
		changes, err = impact.StagedFiles(ctx, e.git)
	} else {
		changes, base, err = impact.Diff(ctx, e.git, e.Opts.BaseRef)
	}
	if err != nil {
		// A repository the platform cannot read the history of is a reason to
		// run everything, not a reason to stop. This is the normal state in a
		// shallow CI checkout and in a freshly initialized repository.
		return impact.Selector{Cfg: e.Cfg, Tier: e.Opts.Tier, Full: true, Only: e.Opts.Only}.
			Select(e.Catalog.Enabled(), nil), nil
	}
	sel := impact.Selector{Cfg: e.Cfg, Tier: e.Opts.Tier, Full: e.Opts.Full, Only: e.Opts.Only}
	p := sel.Select(e.Catalog.Enabled(), changes)
	p.BaseRef = base
	return p, nil
}

// Run performs the whole pipeline and returns the report.
func (e *Engine) Run(ctx context.Context) (*model.Report, error) {
	started := time.Now()
	runSpan, endRun := e.Tracer.Start("run "+string(e.Opts.Tier), "SERVER", "", map[string]any{
		"cicd.pipeline.name":          "continuous-quality",
		"cicd.pipeline.run.id":        e.Tracer.TraceID()[:16],
		"cicd.pipeline.task.run.type": string(e.Opts.Tier),
	})

	plan, err := e.Plan(ctx)
	if err != nil {
		endRun("ERROR", err.Error())
		return nil, err
	}

	artifactDir := filepath.Join(e.Opts.Root, e.Cfg.ArtifactDir)
	reportDir := filepath.Join(e.Opts.Root, e.Cfg.ReportDir)
	if err := os.MkdirAll(artifactDir, 0o755); err != nil {
		endRun("ERROR", err.Error())
		return nil, err
	}

	run := &runner.Runner{
		Root: e.Opts.Root, ArtifactDir: artifactDir, ReportDir: reportDir,
		BaseRef: plan.BaseRef, Tier: e.Opts.Tier, DryRun: e.Opts.DryRun,
	}

	cfgDigest := cache.Digest(e.Cfg.Path, fmt.Sprint(e.Cfg.Version), string(e.Opts.Tier))
	collected := &collector{}

	outcomes := runner.Schedule(ctx, plan.Selected, e.Cfg.Parallelism, func(ctx context.Context, a model.Analyzer) runner.Outcome {
		return e.runOne(ctx, run, plan, a, cfgDigest, collected)
	})

	report := &model.Report{
		Schema: model.SchemaVersion,
		Meta: model.RunMeta{
			ID:        e.Tracer.TraceID()[:16],
			StartedAt: started.UTC(),
			Commit:    impact.HeadCommit(ctx, e.git),
			Branch:    impact.CurrentBranch(ctx, e.git),
			BaseRef:   plan.BaseRef,
			Repo:      repoURL(ctx, e.git),
			CI:        telemetry.DetectCI(),
			Platform:  runtime.GOOS + "/" + runtime.GOARCH,
			Parallel:  e.Cfg.Parallelism,
			PR:        prNumber(),
		},
		Selection: model.Selection{
			Tier: e.Opts.Tier, ChangedFiles: len(plan.ChangedPaths), BaseRef: plan.BaseRef,
			Scopes: plan.Scopes, Selected: plan.SelectedIDs(), Skipped: plan.SkippedIDs(),
			Reason: selectionReason(plan),
		},
	}
	for _, p := range e.Catalog.Problems {
		report.Errors = append(report.Errors, "analyzer catalog: "+p)
	}

	// Fold the outcomes in. An analyzer that broke contributes a platform
	// error, never a finding: a tool crash must never look like a code defect,
	// because an agent told "your code has an error" will change the code.
	for _, o := range outcomes {
		ar, res, perr := e.foldOutcome(o, collected)
		report.Analyzers = append(report.Analyzers, ar)
		report.Findings = append(report.Findings, res.Findings...)
		report.Metrics = append(report.Metrics, res.Metrics...)
		if perr != "" {
			report.Errors = append(report.Errors, perr)
		}
		if ar.Artifact != "" {
			report.Artifacts = append(report.Artifacts, model.Artifact{
				Name: o.Analyzer.Name, Path: rel(e.Opts.Root, ar.Artifact),
				Kind: artifactKind(o.Analyzer), Analyzer: o.Analyzer.ID,
				Bytes: fileSize(ar.Artifact),
			})
		}
	}

	report.Findings = dedupe.Merge(report.Findings)

	// Baseline, then score, then budgets, then score again. The order matters:
	// "new" must be known before a budget can count new findings, and the
	// score must know which budgets failed.
	bl, blErr := baseline.Load(baseline.Path(reportDir, BaselineRef(plan.BaseRef, report.Meta.Branch)))
	if blErr != nil {
		report.Errors = append(report.Errors, "baseline: "+blErr.Error())
	}
	_, provisional := score.Compute(e.Cfg, report.Findings, report.Metrics, nil)
	cmp := baseline.Apply(report.Findings, bl, provisional)

	budgets := policy.Engine{Cfg: e.Cfg, Baseline: bl, Tier: e.Opts.Tier, BaseRef: plan.BaseRef}.
		Evaluate(report.Findings, report.Metrics)
	report.Budgets = budgets

	cats, overall := score.Compute(e.Cfg, report.Findings, report.Metrics, budgets)
	report.Categories = cats
	report.Summary = score.Summarize(report.Findings, budgets, overall,
		cmp.NewCount, cmp.FixedCount, cmp.Present, cmp.ScoreDelta, cmp.Trend)

	if len(report.Errors) > 0 && report.Summary.Verdict != model.VerdictFail {
		// A run where checks did not complete cannot honestly claim a pass. It
		// is not a failure of the code either, so it is reported as a warning
		// with the platform errors named.
		if report.Summary.Verdict == model.VerdictPass {
			report.Summary.Verdict = model.VerdictWarn
			report.Summary.Headline = fmt.Sprintf(
				"%d check(s) could not complete, so this run is not a clean bill of health. %s",
				len(report.Errors), report.Summary.Headline)
		}
	}

	report.Meta.DurationMS = time.Since(started).Milliseconds()
	report.Meta.CacheHits, report.Meta.CacheMiss = e.cache.Stats()
	report.Sort()

	runSpan.Attributes["cq.findings"] = len(report.Findings)
	runSpan.Attributes["cq.score"] = report.Summary.Score
	runSpan.Attributes["cq.verdict"] = string(report.Summary.Verdict)
	runSpan.Attributes["cq.analyzers.selected"] = len(plan.Selected)
	runSpan.Attributes["cq.analyzers.skipped"] = len(plan.Skipped)
	runSpan.Attributes["cq.cache.hits"] = report.Meta.CacheHits
	if report.Summary.Verdict == model.VerdictFail {
		endRun("ERROR", report.Summary.Headline)
	} else {
		endRun("OK", "")
	}
	return report, nil
}

// BaselineRef names the baseline a run reads and writes.
//
// Read and write MUST derive it the same way, and a helper exists purely
// because they once did not: a run with no --base saved under the branch name
// and looked up under "default", so every regression budget silently reported
// "skip" forever. A gate that quietly stops existing is worse than no gate.
func BaselineRef(baseRef, branch string) string {
	if baseRef != "" {
		return baseRef
	}
	if branch != "" {
		return branch
	}
	return "default"
}

// SaveBaseline records this run as the reference for the next one. Passing an
// empty ref uses the same derivation the read path uses.
func (e *Engine) SaveBaseline(r *model.Report, ref string) error {
	dir := filepath.Join(e.Opts.Root, e.Cfg.ReportDir)
	if ref == "" {
		ref = BaselineRef(r.Meta.BaseRef, r.Meta.Branch)
	}
	return baseline.Save(baseline.Path(dir, ref), baseline.FromReport(r))
}

// FlushTelemetry writes the trace out. Advisory: a failure here is logged and
// never changes the verdict.
func (e *Engine) FlushTelemetry(ctx context.Context) error {
	return e.Tracer.Flush(ctx,
		filepath.Join(e.Opts.Root, e.Cfg.ArtifactDir, "trace.otlp.json"),
		e.Cfg.Telemetry.OTLPEndpoint)
}

func selectionReason(p impact.Plan) string {
	switch {
	case p.Full:
		return "full run: every check for this stage, regardless of what changed"
	case len(p.ChangedPaths) == 0:
		return "nothing changed against the base, so only the checks that always run were selected"
	case impact.DocsOnly(p.Scopes):
		return "only documentation changed, so code checks were skipped"
	default:
		return fmt.Sprintf("%d changed file(s) touching %s", len(p.ChangedPaths), strings.Join(p.Scopes, ", "))
	}
}

func repoURL(ctx context.Context, g impact.Git) string {
	out, err := g.Run(ctx, "config", "--get", "remote.origin.url")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

func prNumber() string {
	for _, k := range []string{"GITHUB_REF_NAME", "SYSTEM_PULLREQUEST_PULLREQUESTNUMBER"} {
		if v := os.Getenv(k); v != "" && strings.Contains(v, "/") {
			return strings.Split(v, "/")[0]
		} else if v != "" && k == "SYSTEM_PULLREQUEST_PULLREQUESTNUMBER" {
			return v
		}
	}
	return ""
}

func artifactKind(a model.Analyzer) string {
	if a.Output.Kind != "" {
		return a.Output.Kind
	}
	return a.Output.Format
}

func rel(root, p string) string {
	if r, err := filepath.Rel(root, p); err == nil && !strings.HasPrefix(r, "..") {
		return filepath.ToSlash(r)
	}
	return filepath.ToSlash(p)
}

func fileSize(p string) int64 {
	if st, err := os.Stat(p); err == nil {
		return st.Size()
	}
	return 0
}

// sortStrings is used where the caller wants determinism and the set is tiny.
func sortStrings(s []string) []string {
	sort.Strings(s)
	return s
}

var _ = sortStrings

// normalizerFor is a thin indirection so the engine's tests can assert that a
// manifest's declared format actually exists.
func normalizerFor(format string) bool {
	_, ok := normalize.Get(format)
	return ok
}
