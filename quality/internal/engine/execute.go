package engine

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/abhijeet-oxide/configer/quality/internal/cache"
	"github.com/abhijeet-oxide/configer/quality/internal/impact"
	"github.com/abhijeet-oxide/configer/quality/internal/model"
	"github.com/abhijeet-oxide/configer/quality/internal/normalize"
	"github.com/abhijeet-oxide/configer/quality/internal/runner"
)

// collector holds the per-analyzer normalized results between the scheduler
// (which knows nothing about findings) and the report assembly.
type collector struct {
	mu   sync.Mutex
	byID map[string]normalize.Result
	meta map[string]analyzerMeta
}

type analyzerMeta struct {
	cacheHit bool
	version  string
	artifact string
	duration time.Duration
	err      string
}

func (c *collector) put(id string, res normalize.Result, m analyzerMeta) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.byID == nil {
		c.byID = map[string]normalize.Result{}
		c.meta = map[string]analyzerMeta{}
	}
	c.byID[id] = res
	c.meta[id] = m
}

func (c *collector) get(id string) (normalize.Result, analyzerMeta) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.byID[id], c.meta[id]
}

// runOne is the whole life of a single analyzer: probe, cache lookup, execute,
// normalize, cache store. Every failure mode along the way turns into an
// explained state rather than an exception, because one broken tool must never
// be able to take a run down.
func (e *Engine) runOne(ctx context.Context, run *runner.Runner, plan impact.Plan,
	a model.Analyzer, cfgDigest string, out *collector) runner.Outcome {

	span, end := e.Tracer.Start("analyze "+a.ID, "INTERNAL", "", map[string]any{
		"cicd.pipeline.task.name": a.ID,
		"cq.analyzer.category":    string(a.Category),
		"cq.analyzer.cost":        string(a.Cost),
	})
	start := time.Now()

	version, available := run.Probe(ctx, a)
	if !available {
		// A tool that is not installed is a state, not a failure. Saying so in
		// the analyzer's own words, with the install line from its manifest, is
		// the difference between a fixable gap and a mysterious red build.
		reason := fmt.Sprintf("%s is not available here", firstWord(a.Tool.Command))
		if a.Tool.Install != "" {
			reason += ". " + a.Tool.Install
		}
		out.put(a.ID, normalize.Result{}, analyzerMeta{version: version, duration: time.Since(start)})
		end("OK", "tool unavailable")
		return runner.Outcome{Analyzer: a, Result: runner.Result{
			Skipped: true, Reason: reason, Version: version, Duration: time.Since(start),
		}}
	}
	span.Attributes["cq.tool.version"] = version

	changed := plan.ChangedFilesFor(a)

	// Cache lookup. The key binds the tool version, the exact command, the
	// analyzer's declared inputs and this repository's configuration, so a hit
	// is a statement that nothing which could change the answer has moved.
	var key string
	if !a.Cache.Disabled && len(a.Cache.Inputs) > 0 {
		files, err := cache.Resolve(e.Opts.Root, a.Cache.Inputs, e.Cfg.Ignore)
		if err == nil {
			key, _ = cache.Key(e.Opts.Root, cache.KeyInput{
				AnalyzerID: a.ID, ToolVersion: version,
				Command:      append([]string{a.Tool.Command}, a.Tool.Args...),
				Env:          a.Tool.Env,
				ConfigDigest: cfgDigest,
				Files:        files,
				Extra:        []string{string(e.Opts.Tier)},
			})
		}
	}
	if key != "" {
		if entry, ok := e.cache.Get(key); ok {
			out.put(a.ID, normalize.Result{Findings: entry.Findings, Metrics: entry.Metrics},
				analyzerMeta{cacheHit: true, version: version, artifact: entry.Artifact,
					duration: time.Duration(entry.DurationMS) * time.Millisecond})
			e.progress(fmt.Sprintf("%-28s cached (%d findings)", a.ID, len(entry.Findings)))
			span.Attributes["cq.cache.hit"] = true
			end("OK", "")
			return runner.Outcome{Analyzer: a, Result: runner.Result{
				ExitCode: entry.ExitCode, Version: version,
				Duration: time.Duration(entry.DurationMS) * time.Millisecond,
			}}
		}
	}
	span.Attributes["cq.cache.hit"] = false

	res := run.Run(ctx, a, changed)
	res.Version = version
	logPath := run.WriteLog(a, res)

	if res.Skipped {
		out.put(a.ID, normalize.Result{}, analyzerMeta{version: version, duration: res.Duration})
		end("OK", "dry run")
		return runner.Outcome{Analyzer: a, Result: res}
	}

	// A non-zero exit is NOT a platform problem: almost every linter exits
	// non-zero precisely when it has something to say, and the exit-code format
	// exists to turn that into a finding. Only a tool that could not start, or
	// one that ran out of time, has genuinely failed.
	if res.TimedOut || res.ExitCode < 0 {
		out.put(a.ID, normalize.Result{}, analyzerMeta{
			version: version, artifact: logPath, duration: res.Duration, err: res.Err.Error()})
		e.progress(fmt.Sprintf("%-28s FAILED  %s", a.ID, res.Err))
		end("ERROR", res.Err.Error())
		return runner.Outcome{Analyzer: a, Result: res}
	}

	normalized, nerr := normalize.Run(normalize.Input{
		Analyzer: a, Data: stdoutIfNoFile(a, res), Path: res.OutputPath,
		Root: e.Opts.Root, ExitCode: res.ExitCode, Stderr: res.Stderr,
	})
	meta := analyzerMeta{version: version, duration: res.Duration,
		artifact: firstArtifact(res.OutputPath, logPath)}
	if nerr != nil {
		meta.err = nerr.Error()
		if res.Err != nil {
			meta.err = res.Err.Error() + "; " + nerr.Error()
		}
		out.put(a.ID, normalize.Result{}, meta)
		e.progress(fmt.Sprintf("%-28s FAILED  %s", a.ID, nerr))
		end("ERROR", nerr.Error())
		res.Err = nerr
		return runner.Outcome{Analyzer: a, Result: res}
	}
	// The tool may well have exited non-zero and still produced parseable
	// output. That is the normal shape of a linter with findings, so the exit
	// code is recorded and the findings are kept; it is not an error.
	out.put(a.ID, normalized, meta)

	if key != "" {
		e.cache.Put(cache.Entry{
			Key: key, Analyzer: a.ID, Findings: normalized.Findings, Metrics: normalized.Metrics,
			ExitCode: res.ExitCode, Artifact: meta.artifact, DurationMS: res.Duration.Milliseconds(),
		})
	}
	e.progress(fmt.Sprintf("%-28s %-6s %d finding(s), %d metric(s)",
		a.ID, res.Duration.Round(time.Millisecond), len(normalized.Findings), len(normalized.Metrics)))
	span.Attributes["cq.findings"] = len(normalized.Findings)
	end("OK", "")
	return runner.Outcome{Analyzer: a, Result: res}
}

// foldOutcome turns one scheduler outcome into the report's analyzer row plus
// its contribution of findings and metrics.
func (e *Engine) foldOutcome(o runner.Outcome, c *collector) (model.AnalyzerRun, normalize.Result, string) {
	res, meta := c.get(o.Analyzer.ID)
	ar := model.AnalyzerRun{
		ID: o.Analyzer.ID, Category: o.Analyzer.Category,
		DurationMS: meta.duration.Milliseconds(), CacheHit: meta.cacheHit,
		Findings: len(res.Findings), Metrics: len(res.Metrics),
		ExitCode: o.Result.ExitCode, Artifact: rel(e.Opts.Root, meta.artifact),
		Tool: o.Analyzer.Tool.Command, Version: meta.version,
	}
	switch {
	case o.Blocked:
		ar.Status, ar.Reason = "skipped", o.Reason
		return ar, normalize.Result{}, ""
	case o.Result.Skipped:
		ar.Status, ar.Reason = "skipped", o.Reason
		if ar.Reason == "" {
			ar.Reason = o.Result.Reason
		}
		// An optional analyzer that is simply absent is expected. A required
		// one that is absent is worth naming so somebody fixes the runner.
		if !o.Analyzer.Tool.Optional && !e.Opts.DryRun {
			ar.Status = "missing-tool"
			return ar, normalize.Result{}, fmt.Sprintf("%s did not run: %s", o.Analyzer.ID, ar.Reason)
		}
		return ar, normalize.Result{}, ""
	case meta.err != "":
		ar.Status, ar.Reason = "failed", meta.err
		if o.Result.TimedOut {
			ar.Reason = fmt.Sprintf("timed out after %ds", o.Analyzer.Timeout())
		}
		return ar, normalize.Result{}, fmt.Sprintf("%s did not complete: %s", o.Analyzer.ID, ar.Reason)
	case meta.cacheHit:
		ar.Status = "cached"
	case len(res.Findings) > 0:
		ar.Status = "findings"
	default:
		ar.Status = "ok"
	}
	return ar, res, ""
}

func (e *Engine) progress(line string) {
	if e.Opts.Progress != nil {
		e.Opts.Progress(line)
	}
}

// stdoutIfNoFile decides where the machine-readable output is. A manifest that
// names an output file means the tool wrote one; otherwise stdout is it.
func stdoutIfNoFile(a model.Analyzer, res runner.Result) []byte {
	if a.Output.File != "" {
		return nil
	}
	return res.Stdout
}

func firstArtifact(paths ...string) string {
	for _, p := range paths {
		if p != "" {
			return p
		}
	}
	return ""
}

func firstWord(s string) string {
	for i, r := range s {
		if r == ' ' {
			return s[:i]
		}
	}
	return s
}

var _ = context.Background
