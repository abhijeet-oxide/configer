package normalize

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

func init() {
	Register("cq", normalizeNative)
	Register("exit-code", normalizeExitCode)
}

// The native format exists for the checks no off-the-shelf tool performs: a
// browser probe that counts console errors and duplicate network requests, a
// script that measures something specific to this repository. It is
// deliberately the SIMPLEST possible shape, because anything a team has to
// write by hand should be writable in ten lines of JavaScript.
//
//	{
//	  "findings": [{"rule":"...","title":"...","severity":"error",
//	                "file":"src/x.tsx","line":12,"recommendation":"...",
//	                "evidence":"...","safeToAutomate":false,"tags":["..."]}],
//	  "metrics":  [{"id":"frontend.console.errors","name":"Console errors",
//	                "value":0,"unit":"count","direction":"lower_is_better",
//	                "subject":"/grid"}]
//	}
//
// Everything is optional; an empty object is a valid clean result.
type nativeReport struct {
	Findings []struct {
		Rule           string   `json:"rule"`
		Title          string   `json:"title"`
		Detail         string   `json:"detail"`
		Severity       string   `json:"severity"`
		Confidence     string   `json:"confidence"`
		File           string   `json:"file"`
		Line           int      `json:"line"`
		EndLine        int      `json:"endLine"`
		Column         int      `json:"column"`
		Symbol         string   `json:"symbol"`
		Component      string   `json:"component"`
		Evidence       string   `json:"evidence"`
		Recommendation string   `json:"recommendation"`
		SafeToAutomate *bool    `json:"safeToAutomate"`
		Effort         string   `json:"effort"`
		DocsURL        string   `json:"docsUrl"`
		Category       string   `json:"category"`
		Tags           []string `json:"tags"`
		Occurrences    int      `json:"occurrences"`
	} `json:"findings"`
	Metrics []struct {
		ID        string  `json:"id"`
		Name      string  `json:"name"`
		Value     float64 `json:"value"`
		Unit      string  `json:"unit"`
		Direction string  `json:"direction"`
		Subject   string  `json:"subject"`
		Category  string  `json:"category"`
	} `json:"metrics"`
}

func normalizeNative(in Input) (Result, error) {
	body := strings.TrimSpace(string(in.Data))
	if body == "" {
		return Result{}, nil
	}
	var r nativeReport
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		return Result{}, fmt.Errorf("not a cq-native report: %w", err)
	}
	var res Result
	a := in.Analyzer
	for _, x := range r.Findings {
		sev := model.ParseSeverity(x.Severity)
		if x.Severity == "" {
			sev = ""
		}
		loc := model.Location{
			Path: x.File, Line: x.Line, EndLine: x.EndLine,
			Column: x.Column, Symbol: x.Symbol, Component: x.Component,
		}
		f := finding(a, firstNonEmpty(x.Rule, a.ID), oneLine(x.Title), sev, loc)
		f.Detail = oneLine(truncate(x.Detail, 400))
		f.Evidence = truncate(x.Evidence, 200)
		if x.Recommendation != "" {
			f.Fix.Recommendation = oneLine(x.Recommendation)
		}
		if x.SafeToAutomate != nil {
			f.Fix.SafeToAutomate = *x.SafeToAutomate
		}
		if x.Effort != "" {
			f.Fix.Effort = x.Effort
		}
		if x.DocsURL != "" {
			f.Fix.DocsURL = x.DocsURL
		}
		if x.Confidence != "" {
			f.Conf = model.Confidence(strings.ToLower(x.Confidence))
		}
		if x.Category != "" {
			f.Category = model.Category(x.Category)
		}
		if x.Occurrences > 1 {
			f.Occurrences = x.Occurrences
		}
		f.Tags = mergeTags(f.Tags, x.Tags)
		f.Fingerprint = ""
		f.EnsureFingerprint()
		res.Findings = append(res.Findings, f)
	}
	for _, x := range r.Metrics {
		if x.ID == "" {
			continue
		}
		m := metric(a, x.ID, firstNonEmpty(x.Name, x.ID), x.Value,
			firstNonEmpty(x.Unit, "count"), model.Direction(x.Direction))
		m.Subject = x.Subject
		if x.Category != "" {
			m.Category = model.Category(x.Category)
		}
		res.Metrics = append(res.Metrics, m)
	}
	return res, nil
}

// exit-code is for a tool that has no machine-readable output at all: it either
// succeeds or it does not. A formatter check, a build, a schema validation.
// One finding, the process's own words as evidence, and a pass/fail metric.
func normalizeExitCode(in Input) (Result, error) {
	a := in.Analyzer
	ok := in.ExitCode == 0
	res := Result{Metrics: []model.Metric{
		metric(a, fmt.Sprintf("%s.%s.passed", a.Category, a.ID),
			a.Name+" passed", boolValue(ok), "count", model.HigherBetter),
	}}
	if ok {
		return res, nil
	}
	sev := a.Defaults.Severity
	if sev == "" {
		sev = model.SeverityError
	}
	title := firstNonEmpty(a.Description, a.Name+" failed")
	// A pass/fail tool reports no location of its own, but a finding with no
	// location is a finding nobody opens. The analyzer's own working directory
	// (or its first path trigger) is the honest, coarse answer: it points at
	// the part of the tree the check was looking at.
	f := finding(a, a.ID, title, sev, model.Location{Path: analyzerScope(a)})
	f.Conf = model.ConfidenceHigh
	// The evidence is the tail of stderr, not the whole log: the report is a
	// summary and the log is one link away.
	f.Evidence = truncate(lastLines(string(in.Stderr)+"\n"+string(in.Data), 3), 300)
	if f.Fix.Recommendation == "" {
		f.Fix.Recommendation = "Run the command locally to see the full output; the artifact log has it too."
	}
	res.Findings = append(res.Findings, f)
	return res, nil
}

// analyzerScope is the coarsest useful location for an analyzer that reports
// none: its working directory, else the directory prefix of its first path
// trigger, else nothing.
func analyzerScope(a model.Analyzer) string {
	if a.Tool.Workdir != "" {
		return strings.TrimSuffix(a.Tool.Workdir, "/")
	}
	for _, p := range a.Paths {
		if i := strings.IndexAny(p, "*?{["); i > 0 {
			return strings.TrimSuffix(p[:i], "/")
		}
	}
	return ""
}

func boolValue(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	out := make([]string, 0, n)
	for i := len(lines) - 1; i >= 0 && len(out) < n; i-- {
		if strings.TrimSpace(lines[i]) == "" {
			continue
		}
		out = append([]string{strings.TrimSpace(lines[i])}, out...)
	}
	return strings.Join(out, " | ")
}
