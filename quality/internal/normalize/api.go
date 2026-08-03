package normalize

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

func init() {
	Register("oasdiff", normalizeOasdiff)
	Register("spectral", normalizeSpectral)
}

// oasdiff's breaking-changes JSON. This is the API half of regression-based
// validation: a schema is a promise to somebody else's code, and the only
// meaningful question about a change to it is whether a client that obeyed the
// old contract still works.
type oasdiffChange struct {
	ID         string `json:"id"`
	Text       string `json:"text"`
	Comment    string `json:"comment"`
	Level      int    `json:"level"` // 3 = error/breaking, 2 = warning, 1 = info
	Operation  string `json:"operation"`
	Path       string `json:"path"`
	Source     string `json:"source"`
	SourceFile string `json:"sourceFile"`
	Section    string `json:"section"`
}

func normalizeOasdiff(in Input) (Result, error) {
	body := strings.TrimSpace(string(in.Data))
	if body == "" || body == "null" || body == "[]" {
		return Result{Metrics: []model.Metric{
			metric(in.Analyzer, "api.breaking_changes", "Breaking API changes", 0, "count", model.LowerBetter),
		}}, nil
	}
	var changes []oasdiffChange
	if err := json.Unmarshal([]byte(body), &changes); err != nil {
		return Result{}, fmt.Errorf("not an oasdiff report: %w", err)
	}
	var res Result
	a := in.Analyzer
	breaking := 0
	for _, c := range changes {
		sev := model.SeverityWarning
		if c.Level >= 3 {
			sev = model.SeverityError
			breaking++
		}
		where := model.Location{
			Path:      relPath(firstNonEmpty(c.SourceFile, c.Source)),
			Component: strings.ToUpper(c.Operation) + " " + c.Path,
		}
		f := finding(a, "oasdiff/"+c.ID, oneLine(c.Text), sev, where)
		f.Conf = model.ConfidenceHigh
		f.Detail = oneLine(truncate(c.Comment, 300))
		f.Fix.Recommendation = "Either keep the old shape and add the new one alongside it, or version the endpoint. A published response field is a promise to code you cannot see."
		f.Fix.SafeToAutomate = false
		f.Fix.Effort = "medium"
		f.Tags = append(f.Tags, "api-regression")
		res.Findings = append(res.Findings, f)
	}
	res.Metrics = append(res.Metrics,
		metric(a, "api.breaking_changes", "Breaking API changes", float64(breaking), "count", model.LowerBetter),
		metric(a, "api.contract_changes", "API contract changes", float64(len(changes)), "count", model.LowerBetter))
	return res, nil
}

// Spectral's JSON output: OpenAPI style and correctness linting. It answers a
// different question from oasdiff (is the spec any good, rather than did it
// break), so both run and neither replaces the other.
type spectralIssue struct {
	Code     any    `json:"code"`
	Message  string `json:"message"`
	Path     []any  `json:"path"`
	Severity int    `json:"severity"` // 0 error, 1 warn, 2 info, 3 hint
	Source   string `json:"source"`
	Range    struct {
		Start struct {
			Line      int `json:"line"`
			Character int `json:"character"`
		} `json:"start"`
		End struct {
			Line int `json:"line"`
		} `json:"end"`
	} `json:"range"`
}

func normalizeSpectral(in Input) (Result, error) {
	body := strings.TrimSpace(string(in.Data))
	if body == "" || body == "[]" {
		return Result{Metrics: []model.Metric{
			metric(in.Analyzer, "api.spec_issues", "OpenAPI style issues", 0, "count", model.LowerBetter),
		}}, nil
	}
	var issues []spectralIssue
	if err := json.Unmarshal([]byte(body), &issues); err != nil {
		return Result{}, fmt.Errorf("not a Spectral report: %w", err)
	}
	var res Result
	a := in.Analyzer
	for _, i := range issues {
		sev := model.SeverityNote
		switch i.Severity {
		case 0:
			sev = model.SeverityError
		case 1:
			sev = model.SeverityWarning
		}
		// Spectral reports a JSON pointer path; it is far more useful to a
		// reader than the line number alone.
		var parts []string
		for _, p := range i.Path {
			parts = append(parts, fmt.Sprint(p))
		}
		loc := model.Location{
			Path:      relPath(i.Source),
			Line:      i.Range.Start.Line + 1,
			EndLine:   i.Range.End.Line + 1,
			Column:    i.Range.Start.Character + 1,
			Component: strings.Join(parts, "."),
		}
		f := finding(a, fmt.Sprint(i.Code), oneLine(i.Message), sev, loc)
		f.Conf = model.ConfidenceHigh
		f.Fix.Recommendation = "Fix the handler annotation the spec is generated from, then regenerate: the spec is committed, so it has to travel with the code."
		f.Tags = append(f.Tags, "api")
		res.Findings = append(res.Findings, f)
	}
	res.Metrics = append(res.Metrics,
		metric(a, "api.spec_issues", "OpenAPI style issues", float64(len(issues)), "count", model.LowerBetter))
	return res, nil
}
