package normalize

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

func init() {
	Register("eslint", normalizeESLint)
	Register("knip", normalizeKnip)
	Register("jscpd", normalizeJSCPD)
	Register("dependency-cruiser", normalizeDepCruiser)
}

// --- ESLint -----------------------------------------------------------------

// ESLint's native JSON. Read directly rather than through the SARIF formatter
// because the native output carries two things the SARIF conversion drops and
// the platform needs: `fix`, which tells an agent the change is mechanical, and
// `fatal`, which distinguishes a parse error from a rule violation.
type eslintFile struct {
	FilePath string `json:"filePath"`
	Messages []struct {
		RuleID   string `json:"ruleId"`
		Severity int    `json:"severity"` // 1 warn, 2 error
		Message  string `json:"message"`
		Line     int    `json:"line"`
		Column   int    `json:"column"`
		EndLine  int    `json:"endLine"`
		Fatal    bool   `json:"fatal"`
		Fix      *struct {
			Range []int  `json:"range"`
			Text  string `json:"text"`
		} `json:"fix"`
		Suggestions []struct {
			Desc string `json:"desc"`
		} `json:"suggestions"`
	} `json:"messages"`
	ErrorCount          int `json:"errorCount"`
	WarningCount        int `json:"warningCount"`
	FixableErrorCount   int `json:"fixableErrorCount"`
	FixableWarningCount int `json:"fixableWarningCount"`
}

// reactPerfRules are the ESLint rules that are really performance findings
// rather than style. Routing them to the frontend category with a performance
// tag is what makes "unnecessary re-render" a thing the report can talk about
// at all: the React Compiler's own lint plugin knows about memoization
// violations, and re-labelling its output is far better than guessing at one.
var reactPerfRules = map[string]string{
	"react-hooks/exhaustive-deps":                   "an effect or memo whose dependency list is wrong re-runs when it should not",
	"react-hooks/rules-of-hooks":                    "hooks called conditionally break React's state model",
	"react-compiler/react-compiler":                 "code the React Compiler cannot memoize will re-render on every parent render",
	"react-hooks/react-compiler":                    "code the React Compiler cannot memoize will re-render on every parent render",
	"react-hooks/set-state-in-effect":               "setting state inside an effect causes a second render pass on every change",
	"react-hooks/no-direct-set-state-in-use-effect": "setting state inside an effect causes a second render pass on every change",
}

func normalizeESLint(in Input) (Result, error) {
	body := strings.TrimSpace(string(in.Data))
	if body == "" {
		return Result{}, nil
	}
	var files []eslintFile
	if err := json.Unmarshal([]byte(body), &files); err != nil {
		return Result{}, fmt.Errorf("not an ESLint JSON report: %w", err)
	}
	var res Result
	a := in.Analyzer
	var errors, warnings, fixable, perf int

	for _, f := range files {
		for _, m := range f.Messages {
			sev := model.SeverityWarning
			if m.Severity == 2 {
				sev = model.SeverityError
			}
			if m.Fatal {
				sev = model.SeverityBlocker
			}
			rule := m.RuleID
			if rule == "" {
				rule = "eslint/parse-error"
			}
			fd := finding(a, rule, oneLine(m.Message), sev, model.Location{
				Path: relPath(f.FilePath), Line: m.Line, EndLine: m.EndLine, Column: m.Column,
			})
			fd.Conf = model.ConfidenceHigh
			// A rule with an autofix is, by ESLint's own definition, a
			// mechanical change. That is exactly the signal an agent needs.
			if m.Fix != nil {
				fd.Fix.SafeToAutomate = true
				fd.Fix.Effort = "trivial"
				fd.Fix.Recommendation = "Run `eslint --fix` on this file; the change is mechanical."
				fixable++
			} else if len(m.Suggestions) > 0 {
				fd.Fix.Recommendation = oneLine(m.Suggestions[0].Desc)
				fd.Fix.SafeToAutomate = false
			}
			if why, ok := reactPerfRules[rule]; ok {
				fd.Detail = why
				fd.Tags = append(fd.Tags, "frontend-performance", "react")
				fd.Fix.SafeToAutomate = false
				fd.Fix.Effort = "small"
				perf++
			}
			if m.Severity == 2 {
				errors++
			} else {
				warnings++
			}
			res.Findings = append(res.Findings, fd)
		}
	}
	res.Metrics = append(res.Metrics,
		metric(a, "frontend.lint.errors", "ESLint errors", float64(errors), "count", model.LowerBetter),
		metric(a, "frontend.lint.warnings", "ESLint warnings", float64(warnings), "count", model.LowerBetter),
		metric(a, "frontend.lint.autofixable", "Autofixable lint findings", float64(fixable), "count", model.LowerBetter),
		metric(a, "frontend.react.render_risks", "React render and memoization risks", float64(perf), "count", model.LowerBetter))
	return res, nil
}

// --- Knip -------------------------------------------------------------------

// Knip's JSON. Chosen over ts-prune and depcheck, both archived in 2025,
// because it answers unused FILES, unused EXPORTS and unused DEPENDENCIES from
// one module graph, and AI-written code produces all three in quantity.
type knipReport struct {
	Files  []string    `json:"files"`
	Issues []knipIssue `json:"issues"`
}

type knipIssue struct {
	File            string     `json:"file"`
	Dependencies    []knipItem `json:"dependencies"`
	DevDependencies []knipItem `json:"devDependencies"`
	Unlisted        []knipItem `json:"unlisted"`
	Exports         []knipItem `json:"exports"`
	Types           []knipItem `json:"types"`
	// `duplicates` is an array of GROUPS - each group is the set of names one
	// symbol is exported under - not a flat list like every sibling field.
	// Modelling it flat made the whole report fail to parse, which the engine
	// correctly surfaced as a platform error rather than as "no dead code".
	Duplicates        [][]knipItem `json:"duplicates"`
	UnresolvedImports []knipItem   `json:"unresolved"`
}

type knipItem struct {
	Name string `json:"name"`
	Line int    `json:"line"`
	Col  int    `json:"col"`
}

func normalizeKnip(in Input) (Result, error) {
	body := strings.TrimSpace(string(in.Data))
	if body == "" {
		return Result{}, nil
	}
	var r knipReport
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		return Result{}, fmt.Errorf("not a Knip report: %w", err)
	}
	var res Result
	a := in.Analyzer
	total := 0

	for _, f := range r.Files {
		total++
		fd := finding(a, "knip/unused-file",
			fmt.Sprintf("%s is not reachable from any entry point", relPath(f)),
			model.SeverityNote, model.Location{Path: relPath(f)})
		fd.Conf = model.ConfidenceMedium
		fd.Fix.Recommendation = "Delete the file, or add its entry point to the Knip configuration if it is loaded dynamically."
		fd.Fix.Effort = "trivial"
		res.Findings = append(res.Findings, fd)
	}

	// One row per issue kind Knip reports, so adding a kind is a line rather
	// than a branch. `pick` reads the field off whichever file is in hand.
	type knipKind struct {
		label, rule, advice string
		sev                 model.Severity
		pick                func(knipIssue) []knipItem
	}
	kinds := []knipKind{
		{"unused export", "knip/unused-export", "Remove the export, or the whole symbol if nothing uses it.", model.SeverityNote,
			func(i knipIssue) []knipItem { return i.Exports }},
		{"unused type", "knip/unused-type", "Remove the exported type; nothing imports it.", model.SeverityNote,
			func(i knipIssue) []knipItem { return i.Types }},
		{"unused dependency", "knip/unused-dependency", "Remove the package from package.json; nothing imports it.", model.SeverityWarning,
			func(i knipIssue) []knipItem { return i.Dependencies }},
		{"unused dev dependency", "knip/unused-dev-dependency", "Remove the package from devDependencies.", model.SeverityNote,
			func(i knipIssue) []knipItem { return i.DevDependencies }},
		{"undeclared dependency", "knip/unlisted-dependency", "Add the package to package.json: importing something the manifest does not declare works until it does not.", model.SeverityError,
			func(i knipIssue) []knipItem { return i.Unlisted }},
		{"unresolved import", "knip/unresolved", "Fix the import path; it resolves to nothing.", model.SeverityError,
			func(i knipIssue) []knipItem { return i.UnresolvedImports }},
	}

	for _, iss := range r.Issues {
		for _, group := range iss.Duplicates {
			if len(group) < 2 {
				continue
			}
			total++
			names := make([]string, 0, len(group))
			for _, item := range group {
				names = append(names, item.Name)
			}
			fd := finding(a, "knip/duplicate-export",
				fmt.Sprintf("the same symbol is exported as %s", strings.Join(names, " and ")),
				model.SeverityNote,
				model.Location{Path: relPath(iss.File), Line: group[0].Line, Column: group[0].Col, Symbol: names[0]})
			fd.Conf = model.ConfidenceHigh
			fd.Fix.Recommendation = "Keep one name. Two names for one export means two ways to import it, and callers will use both."
			fd.Fix.Effort = "trivial"
			res.Findings = append(res.Findings, fd)
		}
		for _, k := range kinds {
			for _, item := range k.pick(iss) {
				total++
				fd := finding(a, k.rule,
					fmt.Sprintf("%s: %s", k.label, item.Name), k.sev,
					model.Location{Path: relPath(iss.File), Line: item.Line, Column: item.Col, Symbol: item.Name})
				fd.Conf = model.ConfidenceMedium
				fd.Fix.Recommendation = k.advice
				fd.Fix.Effort = "trivial"
				res.Findings = append(res.Findings, fd)
			}
		}
	}
	res.Metrics = append(res.Metrics,
		metric(a, "general.dead_code.items", "Unused files, exports and dependencies", float64(total), "count", model.LowerBetter))
	return res, nil
}

// --- jscpd ------------------------------------------------------------------

// jscpd's JSON. Copy-paste detection matters more with AI-written code than it
// ever did with hand-written code: a model asked the same question twice
// produces the same block twice, in two files, with two different variable
// names, and nothing else in the toolchain notices.
type jscpdReport struct {
	Statistics struct {
		Total struct {
			Lines           int     `json:"lines"`
			Sources         int     `json:"sources"`
			Clones          int     `json:"clones"`
			Duplicates      int     `json:"duplicates"`
			DuplicatedLines int     `json:"duplicatedLines"`
			Percentage      float64 `json:"percentage"`
		} `json:"total"`
	} `json:"statistics"`
	Duplicates []struct {
		Lines     int    `json:"lines"`
		Tokens    int    `json:"tokens"`
		Format    string `json:"format"`
		FirstFile struct {
			Name  string `json:"name"`
			Start int    `json:"start"`
			End   int    `json:"end"`
		} `json:"firstFile"`
		SecondFile struct {
			Name  string `json:"name"`
			Start int    `json:"start"`
			End   int    `json:"end"`
		} `json:"secondFile"`
		Fragment string `json:"fragment"`
	} `json:"duplicates"`
}

func normalizeJSCPD(in Input) (Result, error) {
	body := strings.TrimSpace(string(in.Data))
	if body == "" {
		return Result{}, nil
	}
	var r jscpdReport
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		return Result{}, fmt.Errorf("not a jscpd report: %w", err)
	}
	var res Result
	a := in.Analyzer
	for _, d := range r.Duplicates {
		sev := model.SeverityNote
		if d.Lines >= 50 {
			sev = model.SeverityWarning
		}
		fd := finding(a, "jscpd/duplicate",
			fmt.Sprintf("%d duplicated lines shared between %s and %s",
				d.Lines, relPath(d.FirstFile.Name), relPath(d.SecondFile.Name)), sev,
			model.Location{Path: relPath(d.FirstFile.Name), Line: d.FirstFile.Start, EndLine: d.FirstFile.End},
			model.Location{Path: relPath(d.SecondFile.Name), Line: d.SecondFile.Start, EndLine: d.SecondFile.End})
		fd.Conf = model.ConfidenceHigh
		fd.Evidence = truncate(d.Fragment, 200)
		fd.Fix.Recommendation = "Extract the shared block into one function and call it from both places, or delete whichever copy is the accident."
		fd.Fix.SafeToAutomate = false
		fd.Fix.Effort = "small"
		res.Findings = append(res.Findings, fd)
	}
	res.Metrics = append(res.Metrics,
		metric(a, "general.duplication.percent", "Duplicated code", r.Statistics.Total.Percentage, "percent", model.LowerBetter),
		metric(a, "general.duplication.lines", "Duplicated lines", float64(r.Statistics.Total.DuplicatedLines), "count", model.LowerBetter),
		metric(a, "general.duplication.clones", "Duplicated blocks", float64(r.Statistics.Total.Clones), "count", model.LowerBetter))
	return res, nil
}

// --- dependency-cruiser -----------------------------------------------------

// dependency-cruiser's JSON. It is the tool that can state a rule about the
// module graph ("nothing under components may import from api directly") and
// not merely report cycles, which makes it an architecture gate rather than a
// metric.
type depCruiseReport struct {
	Summary struct {
		Violations []struct {
			Type string `json:"type"`
			From string `json:"from"`
			To   string `json:"to"`
			Rule struct {
				Name     string `json:"name"`
				Severity string `json:"severity"`
			} `json:"rule"`
			Cycle []struct {
				Name string `json:"name"`
			} `json:"cycle"`
			Comment string `json:"comment"`
		} `json:"violations"`
		TotalCruised int `json:"totalCruised"`
		Error        int `json:"error"`
		Warn         int `json:"warn"`
		Info         int `json:"info"`
	} `json:"summary"`
}

func normalizeDepCruiser(in Input) (Result, error) {
	body := strings.TrimSpace(string(in.Data))
	if body == "" {
		return Result{}, nil
	}
	var r depCruiseReport
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		return Result{}, fmt.Errorf("not a dependency-cruiser report: %w", err)
	}
	var res Result
	a := in.Analyzer
	cycles := 0
	for _, v := range r.Summary.Violations {
		sev := model.ParseSeverity(v.Rule.Severity)
		title := fmt.Sprintf("%s: %s depends on %s", v.Rule.Name, relPath(v.From), relPath(v.To))
		if len(v.Cycle) > 0 {
			cycles++
			names := make([]string, 0, len(v.Cycle))
			for _, c := range v.Cycle {
				names = append(names, relPath(c.Name))
			}
			title = "Import cycle: " + strings.Join(append([]string{relPath(v.From)}, names...), " -> ")
		}
		fd := finding(a, "depcruise/"+v.Rule.Name, oneLine(title), sev,
			model.Location{Path: relPath(v.From)}, model.Location{Path: relPath(v.To)})
		fd.Conf = model.ConfidenceHigh
		fd.Detail = oneLine(truncate(v.Comment, 240))
		fd.Fix.Recommendation = "Break the edge: move the shared type or helper into a module both sides may depend on."
		fd.Fix.SafeToAutomate = false
		fd.Fix.Effort = "medium"
		res.Findings = append(res.Findings, fd)
	}
	sort.SliceStable(res.Findings, func(i, j int) bool { return res.Findings[i].Title < res.Findings[j].Title })
	res.Metrics = append(res.Metrics,
		metric(a, "frontend.circular_dependencies", "Import cycles", float64(cycles), "count", model.LowerBetter),
		metric(a, "frontend.dependency_violations", "Module boundary violations",
			float64(len(r.Summary.Violations)), "count", model.LowerBetter),
		metric(a, "frontend.modules", "Modules in the graph", float64(r.Summary.TotalCruised), "count", model.HigherBetter))
	return res, nil
}
