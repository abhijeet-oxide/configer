package report

import (
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

// This file emits the two open standards the surrounding ecosystem already
// consumes. Neither is a lossy afterthought: SARIF is what GitHub's code
// scanning tab, Azure DevOps' SARIF viewer, VS Code's SARIF extension and every
// security dashboard read, and JUnit XML is what every CI system's test panel
// reads. Emitting both means the platform's output shows up in tools nobody had
// to configure.

const sarifSchema = "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json"

// WriteSARIF emits the merged findings as one SARIF 2.1.0 log.
//
// One run, not one per tool: the platform has already deduplicated across
// tools, and re-splitting the results would put the same finding in the code
// scanning tab twice under two rule ids. The driver is the platform itself and
// the originating tool is carried as a rule property.
func WriteSARIF(path string, r *model.Report) error {
	rules := map[string]map[string]any{}
	var results []map[string]any

	for _, f := range r.Findings {
		ruleID := sarifRuleID(f)
		if _, ok := rules[ruleID]; !ok {
			rules[ruleID] = map[string]any{
				"id":               ruleID,
				"name":             ruleID,
				"shortDescription": map[string]any{"text": clip(f.Title, 120)},
				"fullDescription":  map[string]any{"text": firstNonEmpty(f.Detail, f.Title)},
				"help": map[string]any{
					"text": firstNonEmpty(f.Fix.Recommendation, "See the analyzer documentation."),
				},
				"defaultConfiguration": map[string]any{"level": sarifLevel(f.Severity)},
				"properties": map[string]any{
					"tags":       append([]string{string(f.Category)}, f.Tags...),
					"analyzer":   f.Analyzer,
					"confidence": string(f.Conf),
					"precision":  sarifPrecision(f.Conf),
				},
			}
			if f.Fix.DocsURL != "" {
				rules[ruleID]["helpUri"] = f.Fix.DocsURL
			}
		}
		res := map[string]any{
			"ruleId":  ruleID,
			"level":   sarifLevel(f.Severity),
			"message": map[string]any{"text": f.Title},
			"partialFingerprints": map[string]any{
				"cqFingerprint/v1": f.Fingerprint,
			},
			"properties": map[string]any{
				"confidence":     string(f.Conf),
				"safeToAutomate": f.Fix.SafeToAutomate,
				"new":            f.New,
				"tools":          f.Tools,
			},
		}
		if locs := sarifLocs(f); len(locs) > 0 {
			res["locations"] = locs
		}
		results = append(results, res)
	}

	ruleList := make([]map[string]any, 0, len(rules))
	ids := make([]string, 0, len(rules))
	for id := range rules {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		ruleList = append(ruleList, rules[id])
	}

	log := map[string]any{
		"$schema": sarifSchema,
		"version": "2.1.0",
		"runs": []map[string]any{{
			"tool": map[string]any{"driver": map[string]any{
				"name":            "Continuous Quality Platform",
				"informationUri":  "https://github.com/abhijeet-oxide/configer/tree/main/quality",
				"semanticVersion": model.SchemaVersion,
				"rules":           ruleList,
			}},
			"results": results,
			"automationDetails": map[string]any{
				"id": fmt.Sprintf("cq/%s/%s", r.Selection.Tier, r.Meta.ID),
			},
			"versionControlProvenance": []map[string]any{{
				"repositoryUri": r.Meta.Repo,
				"revisionId":    r.Meta.Commit,
				"branch":        r.Meta.Branch,
			}},
		}},
	}
	return writeJSONFile(path, log)
}

func sarifRuleID(f model.Finding) string {
	if f.Rule == "" {
		return f.Analyzer
	}
	if strings.HasPrefix(f.Rule, f.Analyzer+"/") {
		return f.Rule
	}
	return f.Analyzer + "/" + f.Rule
}

func sarifLevel(s model.Severity) string {
	switch s {
	case model.SeverityBlocker, model.SeverityError:
		return "error"
	case model.SeverityWarning:
		return "warning"
	case model.SeverityNote:
		return "note"
	default:
		return "none"
	}
}

func sarifPrecision(c model.Confidence) string {
	switch c {
	case model.ConfidenceHigh:
		return "high"
	case model.ConfidenceLow:
		return "low"
	default:
		return "medium"
	}
}

func sarifLocs(f model.Finding) []map[string]any {
	var out []map[string]any
	for _, l := range f.Where {
		if l.Path == "" {
			continue
		}
		region := map[string]any{}
		if l.Line > 0 {
			region["startLine"] = l.Line
			if l.EndLine >= l.Line {
				region["endLine"] = l.EndLine
			}
			if l.Column > 0 {
				region["startColumn"] = l.Column
			}
		}
		phys := map[string]any{
			"artifactLocation": map[string]any{"uri": l.Path},
		}
		if len(region) > 0 {
			phys["region"] = region
		}
		loc := map[string]any{"physicalLocation": phys}
		if l.Symbol != "" || l.Component != "" {
			loc["logicalLocations"] = []map[string]any{{
				"name":               firstNonEmpty(l.Symbol, l.Component),
				"fullyQualifiedName": firstNonEmpty(l.Component, l.Symbol),
			}}
		}
		out = append(out, loc)
	}
	return out
}

// --- JUnit ------------------------------------------------------------------

type junitOut struct {
	XMLName  xml.Name        `xml:"testsuites"`
	Name     string          `xml:"name,attr"`
	Tests    int             `xml:"tests,attr"`
	Failures int             `xml:"failures,attr"`
	Time     float64         `xml:"time,attr"`
	Suites   []junitOutSuite `xml:"testsuite"`
}

type junitOutSuite struct {
	Name     string         `xml:"name,attr"`
	Tests    int            `xml:"tests,attr"`
	Failures int            `xml:"failures,attr"`
	Skipped  int            `xml:"skipped,attr"`
	Cases    []junitOutCase `xml:"testcase"`
}

type junitOutCase struct {
	Name      string           `xml:"name,attr"`
	ClassName string           `xml:"classname,attr"`
	Failure   *junitOutFailure `xml:"failure,omitempty"`
	Skipped   *struct {
		Message string `xml:"message,attr"`
	} `xml:"skipped,omitempty"`
	SystemOut string `xml:"system-out,omitempty"`
}

type junitOutFailure struct {
	Message string `xml:"message,attr"`
	Type    string `xml:"type,attr"`
	Text    string `xml:",chardata"`
}

// WriteJUnit projects the BUDGETS onto JUnit XML, one test case per budget.
//
// Findings deliberately do not become test cases. A CI test panel is a list of
// things that must hold, and the things that must hold here are the budgets: a
// panel with four thousand "tests" in it, one per lint warning, is a panel
// nobody opens. Findings live in the SARIF, where a code scanning tab can
// annotate the diff with them properly.
func WriteJUnit(path string, r *model.Report) error {
	suites := map[model.Category]*junitOutSuite{}
	order := []model.Category{}
	get := func(c model.Category) *junitOutSuite {
		if s, ok := suites[c]; ok {
			return s
		}
		s := &junitOutSuite{Name: "quality." + string(c)}
		suites[c] = s
		order = append(order, c)
		return s
	}

	total, failures := 0, 0
	for _, b := range r.Budgets {
		s := get(b.Category)
		c := junitOutCase{Name: b.Budget, ClassName: "budget." + string(b.Category)}
		switch b.Status {
		case model.BudgetFail:
			if b.Blocking {
				failures++
				s.Failures++
				c.Failure = &junitOutFailure{
					Message: clip(b.Message, 400), Type: "budget-exceeded",
					Text: fmt.Sprintf("%s\nRule: %s\nMetric: %s", b.Message, b.Limit, b.MetricKey),
				}
			} else {
				c.SystemOut = "advisory budget exceeded: " + b.Message
			}
		case model.BudgetSkip:
			s.Skipped++
			c.Skipped = &struct {
				Message string `xml:"message,attr"`
			}{Message: b.Message}
		default:
			c.SystemOut = b.Message
		}
		s.Tests++
		s.Cases = append(s.Cases, c)
		total++
	}

	out := junitOut{
		Name: "Continuous Quality Platform", Tests: total, Failures: failures,
		Time: float64(r.Meta.DurationMS) / 1000,
	}
	for _, c := range order {
		out.Suites = append(out.Suites, *suites[c])
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := xml.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append([]byte(xml.Header), append(b, '\n')...), 0o644)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
