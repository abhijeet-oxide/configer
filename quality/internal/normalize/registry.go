// Package normalize turns whatever a tool emitted into the platform's own
// vocabulary. It is organized by FORMAT, not by tool, and that is the design
// decision that keeps the catalog cheap: SARIF alone carries golangci-lint,
// Semgrep, Trivy, Gitleaks, OSV-Scanner, Checkov, Hadolint and KubeLinter, so
// eight tools cost one normalizer and eight YAML files.
package normalize

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

// Input is one analyzer's raw output plus the context needed to interpret it.
type Input struct {
	Analyzer model.Analyzer
	// Data is the machine-readable output: the contents of Output.File when the
	// manifest named one, otherwise the process's stdout.
	Data []byte
	// Path is where Data came from, used to make locations repository-relative.
	Path     string
	Root     string
	ExitCode int
	Stderr   []byte
}

// Result is the normalized outcome.
type Result struct {
	Findings []model.Finding
	Metrics  []model.Metric
}

// Add merges another result in.
func (r *Result) Add(other Result) {
	r.Findings = append(r.Findings, other.Findings...)
	r.Metrics = append(r.Metrics, other.Metrics...)
}

// Normalizer reads one output format.
type Normalizer func(Input) (Result, error)

var registry = map[string]Normalizer{}

// Register adds a normalizer. Called from each file's init; the set is closed
// at compile time on purpose, because a format is code and a tool is data.
func Register(format string, n Normalizer) { registry[format] = n }

// Get returns a normalizer by format name.
func Get(format string) (Normalizer, bool) {
	n, ok := registry[format]
	return n, ok
}

// Formats lists every registered format, for `cq doctor`.
func Formats() []string {
	out := make([]string, 0, len(registry))
	for f := range registry {
		out = append(out, f)
	}
	sort.Strings(out)
	return out
}

// Run normalizes one analyzer's output, reading the artifact file when the
// manifest named one. A tool that was expected to write a file and did not is
// reported as a platform error rather than as "no findings", because silently
// scoring a broken analyzer as clean is the worst thing this package could do.
func Run(in Input) (Result, error) {
	n, ok := Get(in.Analyzer.Output.Format)
	if !ok {
		return Result{}, fmt.Errorf("analyzer %q: unknown output format %q (known: %s)",
			in.Analyzer.ID, in.Analyzer.Output.Format, strings.Join(Formats(), ", "))
	}
	if in.Analyzer.Output.File != "" && in.Path != "" && len(in.Data) == 0 {
		b, err := os.ReadFile(in.Path)
		if err != nil {
			return Result{}, fmt.Errorf("analyzer %q did not produce %s: %w",
				in.Analyzer.ID, filepath.Base(in.Path), err)
		}
		in.Data = b
	}
	res, err := n(in)
	if err != nil {
		return Result{}, fmt.Errorf("analyzer %q: %w", in.Analyzer.ID, err)
	}
	for i := range res.Findings {
		res.Findings[i].EnsureFingerprint()
	}
	return res, nil
}

// --- shared construction helpers -------------------------------------------

// finding builds a Finding with the analyzer's manifest defaults applied. Every
// normalizer goes through here so that confidence, automation safety and effort
// are decided in one reviewed place (the manifest) rather than scattered across
// format parsers.
func finding(a model.Analyzer, rule, title string, sev model.Severity, where ...model.Location) model.Finding {
	if sev == "" {
		sev = a.Defaults.Severity
	}
	if sev == "" {
		sev = model.SeverityWarning
	}
	conf := a.Defaults.Confidence
	if conf == "" {
		conf = model.ConfidenceMedium
	}
	for i := range where {
		where[i].Path = relPath(where[i].Path)
	}
	f := model.Finding{
		Analyzer: a.ID,
		Rule:     rule,
		Category: a.Category,
		Severity: sev,
		Conf:     conf,
		Title:    title,
		Where:    where,
		Tags:     a.Tags,
		Fix: model.Fix{
			Recommendation: a.Defaults.Recommendation,
			SafeToAutomate: a.Defaults.SafeToAutomate,
			Effort:         a.Defaults.Effort,
			DocsURL:        a.Defaults.DocsURL,
		},
		Tools:       []string{a.ID},
		Occurrences: 1,
	}
	f.EnsureFingerprint()
	return f
}

// metric builds a Metric attributed to the analyzer.
func metric(a model.Analyzer, id, name string, value float64, unit string, dir model.Direction) model.Metric {
	if dir == "" {
		dir = model.LowerBetter
	}
	return model.Metric{
		ID: id, Name: name, Value: value, Unit: unit,
		Direction: dir, Analyzer: a.ID, Category: a.Category,
	}
}

// relPath makes a location repository-relative and slash-separated. Tools are
// wildly inconsistent here (absolute paths, file:// URIs, ./ prefixes), and a
// report whose paths only work on the machine that produced it is not a report.
func relPath(p string) string {
	if p == "" {
		return ""
	}
	p = strings.TrimPrefix(p, "file://")
	p = filepath.ToSlash(p)
	if wd, err := os.Getwd(); err == nil && filepath.IsAbs(p) {
		if rel, err := filepath.Rel(wd, p); err == nil && !strings.HasPrefix(rel, "..") {
			p = filepath.ToSlash(rel)
		}
	}
	return strings.TrimPrefix(p, "./")
}

// truncate keeps evidence to a quotation rather than a transcript.
func truncate(s string, n int) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\r", ""))
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// firstNonEmpty is used constantly by format parsers where a field may live
// under two names depending on the emitting tool's version.
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
