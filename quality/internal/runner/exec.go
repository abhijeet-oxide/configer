// Package runner executes analyzers. It owns process invocation, templating,
// timeouts, artifact capture and tool-availability probing, and it is the only
// place in the platform that starts a child process.
package runner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

// Vars are the substitutions available inside a manifest's args, env and output
// path. Keeping the set small and named is what stops manifests turning into
// shell scripts.
type Vars struct {
	Repo         string   // absolute repository root
	Workdir      string   // absolute working directory for this analyzer
	ArtifactDir  string   // absolute artifact directory
	ReportDir    string   // absolute report directory
	Out          string   // absolute path this analyzer's output file
	BaseRef      string   // the ref the change is measured against
	ChangedFiles []string // repository-relative, already filtered for this analyzer
	Tier         model.Tier
}

// Render substitutes {name} placeholders. An unknown placeholder is left alone
// rather than blanked: a typo that silently becomes an empty argument is far
// harder to diagnose than one that shows up verbatim in the command line.
func (v Vars) Render(s string) string {
	rep := strings.NewReplacer(
		"{repo}", v.Repo,
		"{workdir}", v.Workdir,
		"{artifacts}", v.ArtifactDir,
		"{reports}", v.ReportDir,
		"{out}", v.Out,
		"{base_ref}", v.BaseRef,
		"{tier}", string(v.Tier),
		"{changed_files}", strings.Join(v.ChangedFiles, " "),
	)
	return rep.Replace(s)
}

// Result is the raw outcome of one analyzer process, before normalization.
type Result struct {
	Analyzer   model.Analyzer
	ExitCode   int
	Stdout     []byte
	Stderr     []byte
	OutputPath string // where the machine-readable output landed, if a file
	Duration   time.Duration
	TimedOut   bool
	Err        error
	// Skipped and Reason describe an analyzer that never ran: a missing tool, a
	// failed prerequisite. This is a state, not a failure.
	Skipped bool
	Reason  string
	Version string
}

// Runner executes analyzer manifests.
type Runner struct {
	Root        string
	ArtifactDir string
	ReportDir   string
	BaseRef     string
	Tier        model.Tier
	// ExtraEnv is merged into every child process, after the analyzer's own.
	ExtraEnv map[string]string
	// DryRun prints what would run without running it.
	DryRun bool
}

// Probe reports whether an analyzer's tool is present and returns its version.
// A missing tool is answered here, once, so the scheduler can turn it into an
// explained skip rather than a red analyzer.
func (r *Runner) Probe(ctx context.Context, a model.Analyzer) (version string, ok bool) {
	probe := a.Tool.Probe
	if len(probe) == 0 {
		if _, err := exec.LookPath(a.Tool.Command); err != nil {
			return "", false
		}
		probe = append([]string{a.Tool.Command}, a.Tool.VersionArgs...)
		if len(a.Tool.VersionArgs) == 0 {
			return a.Tool.Pin, true
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, probe[0], probe[1:]...)
	cmd.Dir = r.workdir(a)
	cmd.Env = r.env(a)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", false
	}
	return firstLine(string(out)), true
}

// Run executes one analyzer to completion.
func (r *Runner) Run(ctx context.Context, a model.Analyzer, changed []string) Result {
	start := time.Now()
	res := Result{Analyzer: a}

	outPath := ""
	if a.Output.File != "" {
		v := r.vars(a, changed, "")
		outPath = v.Render(a.Output.File)
		if !filepath.IsAbs(outPath) {
			outPath = filepath.Join(r.ArtifactDir, outPath)
		}
		if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
			res.Err = err
			return res
		}
		// A stale output file from a previous run would be silently normalized
		// as if it were this run's answer, so it goes first.
		_ = os.Remove(outPath)
	}
	res.OutputPath = outPath

	v := r.vars(a, changed, outPath)
	args := make([]string, 0, len(a.Tool.Args)+len(changed)*2)
	for _, x := range a.Tool.Args {
		args = append(args, v.Render(x))
	}
	if a.ChangedFilesArg != "" && len(changed) > 0 &&
		(a.MaxChangedFiles == 0 || len(changed) <= a.MaxChangedFiles) {
		for _, f := range changed {
			if a.ChangedFilesArg != "-" {
				args = append(args, a.ChangedFilesArg)
			}
			args = append(args, f)
		}
	}

	if r.DryRun {
		res.Reason = strings.Join(append([]string{a.Tool.Command}, args...), " ")
		res.Skipped = true
		return res
	}

	timeout := time.Duration(a.Timeout()) * time.Second
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, v.Render(a.Tool.Command), args...)
	cmd.Dir = r.workdir(a)
	cmd.Env = r.env(a)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()

	res.Duration = time.Since(start)
	res.Stdout = stdout.Bytes()
	res.Stderr = stderr.Bytes()
	res.ExitCode = exitCodeOf(err)
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		res.TimedOut = true
		res.Err = fmt.Errorf("%s did not finish within %s", a.ID, timeout)
		return res
	}
	if err != nil && !okExit(a, res.ExitCode) {
		res.Err = fmt.Errorf("%s exited %d", a.ID, res.ExitCode)
	}
	return res
}

// WriteLog persists an analyzer's console output next to its structured
// artifact. The report never quotes a log; it links to one, and this is where
// that link points.
func (r *Runner) WriteLog(a model.Analyzer, res Result) string {
	if len(res.Stdout) == 0 && len(res.Stderr) == 0 {
		return ""
	}
	p := filepath.Join(r.ArtifactDir, "logs", a.ID+".log")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return ""
	}
	var b bytes.Buffer
	if len(res.Stdout) > 0 {
		b.WriteString("--- stdout ---\n")
		b.Write(res.Stdout)
		b.WriteByte('\n')
	}
	if len(res.Stderr) > 0 {
		b.WriteString("--- stderr ---\n")
		b.Write(res.Stderr)
		b.WriteByte('\n')
	}
	if os.WriteFile(p, b.Bytes(), 0o644) != nil {
		return ""
	}
	return p
}

func (r *Runner) vars(a model.Analyzer, changed []string, out string) Vars {
	return Vars{
		Repo: r.Root, Workdir: r.workdir(a),
		ArtifactDir: r.ArtifactDir, ReportDir: r.ReportDir,
		Out: out, BaseRef: r.BaseRef, ChangedFiles: changed, Tier: r.Tier,
	}
}

func (r *Runner) workdir(a model.Analyzer) string {
	if a.Tool.Workdir == "" {
		return r.Root
	}
	if filepath.IsAbs(a.Tool.Workdir) {
		return a.Tool.Workdir
	}
	return filepath.Join(r.Root, a.Tool.Workdir)
}

// env builds the child environment. The parent's environment is inherited so
// PATH, HOME and CI credentials work, then the manifest's own values are
// layered on, then the run's. CQ_* variables let a manifest's own script know
// where it is without re-deriving it.
func (r *Runner) env(a model.Analyzer) []string {
	env := os.Environ()
	add := func(k, val string) { env = append(env, k+"="+val) }
	v := r.vars(a, nil, "")
	for k, val := range a.Tool.Env {
		add(k, v.Render(val))
	}
	for k, val := range r.ExtraEnv {
		add(k, val)
	}
	add("CQ_REPO", r.Root)
	add("CQ_ARTIFACTS", r.ArtifactDir)
	add("CQ_REPORTS", r.ReportDir)
	add("CQ_TIER", string(r.Tier))
	add("CQ_BASE_REF", r.BaseRef)
	add("CQ_ANALYZER", a.ID)
	return env
}

func okExit(a model.Analyzer, code int) bool {
	if code == 0 {
		return true
	}
	for _, c := range a.Tool.OkExitCodes {
		if c == code {
			return true
		}
	}
	return false
}

func exitCodeOf(err error) int {
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}
