package normalize

import (
	"bufio"
	"encoding/xml"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

func init() {
	Register("lcov", normalizeLCOV)
	Register("go-cover", normalizeGoCover)
	Register("cobertura", normalizeCobertura)
}

// coverageTotals is what all three coverage formats reduce to. Keeping the
// reduction identical is what lets one budget ("coverage may not fall") hold
// across a Go backend and a TypeScript frontend without knowing about either.
type coverageTotals struct {
	linesFound  int
	linesHit    int
	branchFound int
	branchHit   int
	funcFound   int
	funcHit     int
	perFile     map[string]*fileCoverage
}

type fileCoverage struct{ found, hit int }

func newTotals() *coverageTotals {
	return &coverageTotals{perFile: map[string]*fileCoverage{}}
}

func (t *coverageTotals) file(p string) *fileCoverage {
	fc, ok := t.perFile[p]
	if !ok {
		fc = &fileCoverage{}
		t.perFile[p] = fc
	}
	return fc
}

// result turns totals into metrics, and into findings for the files that are
// worst off. Naming the least-covered files is the difference between "coverage
// is 71%" (which nobody acts on) and "these four files carry the gap".
func (t *coverageTotals) result(a model.Analyzer, worstN int) Result {
	var res Result
	pct := func(hit, found int) float64 {
		if found == 0 {
			return 0
		}
		return float64(hit) / float64(found) * 100
	}
	if t.linesFound > 0 {
		res.Metrics = append(res.Metrics,
			metric(a, "general.coverage.lines", "Line coverage", pct(t.linesHit, t.linesFound), "percent", model.HigherBetter),
			metric(a, "general.coverage.lines_total", "Coverable lines", float64(t.linesFound), "count", model.HigherBetter))
	}
	if t.branchFound > 0 {
		res.Metrics = append(res.Metrics,
			metric(a, "general.coverage.branches", "Branch coverage", pct(t.branchHit, t.branchFound), "percent", model.HigherBetter))
	}
	if t.funcFound > 0 {
		res.Metrics = append(res.Metrics,
			metric(a, "general.coverage.functions", "Function coverage", pct(t.funcHit, t.funcFound), "percent", model.HigherBetter))
	}

	type entry struct {
		path string
		pct  float64
		gap  int
	}
	var entries []entry
	for p, fc := range t.perFile {
		if fc.found < 10 {
			// A three-line file at 0% is noise, not a coverage problem.
			continue
		}
		entries = append(entries, entry{p, pct(fc.hit, fc.found), fc.found - fc.hit})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].gap != entries[j].gap {
			return entries[i].gap > entries[j].gap
		}
		return entries[i].path < entries[j].path
	})
	for i, e := range entries {
		if i >= worstN || e.pct >= 50 {
			break
		}
		f := finding(a, "coverage.low",
			fmt.Sprintf("%s is %.0f%% covered (%d uncovered lines)", e.path, e.pct, e.gap),
			model.SeverityNote, model.Location{Path: e.path})
		f.Conf = model.ConfidenceHigh
		f.Fix.Recommendation = "Add tests for the uncovered branches in this file, starting with its error paths."
		f.Fix.SafeToAutomate = false
		f.Fix.Effort = "medium"
		res.Findings = append(res.Findings, f)
	}
	return res
}

// LCOV: the format Vitest, Jest, c8 and nyc all emit.
func normalizeLCOV(in Input) (Result, error) {
	t := newTotals()
	sc := bufio.NewScanner(strings.NewReader(string(in.Data)))
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	var cur *fileCoverage
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		key, val, _ := strings.Cut(line, ":")
		switch key {
		case "SF":
			cur = t.file(relPath(val))
		case "LF":
			n := atoi(val)
			t.linesFound += n
			if cur != nil {
				cur.found += n
			}
		case "LH":
			n := atoi(val)
			t.linesHit += n
			if cur != nil {
				cur.hit += n
			}
		case "BRF":
			t.branchFound += atoi(val)
		case "BRH":
			t.branchHit += atoi(val)
		case "FNF":
			t.funcFound += atoi(val)
		case "FNH":
			t.funcHit += atoi(val)
		case "end_of_record":
			cur = nil
		}
	}
	if err := sc.Err(); err != nil {
		return Result{}, err
	}
	return t.result(in.Analyzer, 5), nil
}

// Go's own coverage profile: "mode: set" then one line per block,
// file.go:startLine.col,endLine.col numStatements count.
func normalizeGoCover(in Input) (Result, error) {
	t := newTotals()
	sc := bufio.NewScanner(strings.NewReader(string(in.Data)))
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "mode:") {
			continue
		}
		// path:range numStatements count
		lastSpace := strings.LastIndexByte(line, ' ')
		if lastSpace < 0 {
			continue
		}
		count := atoi(line[lastSpace+1:])
		rest := line[:lastSpace]
		secondSpace := strings.LastIndexByte(rest, ' ')
		if secondSpace < 0 {
			continue
		}
		stmts := atoi(rest[secondSpace+1:])
		loc := rest[:secondSpace]
		path := loc
		if i := strings.LastIndexByte(loc, ':'); i >= 0 {
			path = loc[:i]
		}
		// Go writes import paths, not file paths. Trimming the module prefix is
		// what makes the location clickable in the report.
		path = trimModulePrefix(path)
		fc := t.file(path)
		fc.found += stmts
		t.linesFound += stmts
		if count > 0 {
			fc.hit += stmts
			t.linesHit += stmts
		}
	}
	if err := sc.Err(); err != nil {
		return Result{}, err
	}
	return t.result(in.Analyzer, 5), nil
}

// trimModulePrefix turns github.com/org/repo/backend/internal/x/y.go into
// backend/internal/x/y.go by dropping everything up to the first path segment
// that looks like a directory in the repository rather than a domain.
func trimModulePrefix(p string) string {
	parts := strings.Split(p, "/")
	for i, part := range parts {
		if strings.Contains(part, ".") && i < 2 {
			continue
		}
		if i >= 3 {
			return strings.Join(parts[3:], "/")
		}
		break
	}
	return p
}

// Cobertura: what Azure DevOps' publish task and many Python/Java runners speak.
type coberturaDoc struct {
	XMLName  xml.Name `xml:"coverage"`
	Packages struct {
		Packages []struct {
			Classes struct {
				Classes []struct {
					Filename string `xml:"filename,attr"`
					Lines    struct {
						Lines []struct {
							Hits   int    `xml:"hits,attr"`
							Branch string `xml:"branch,attr"`
						} `xml:"line"`
					} `xml:"lines"`
				} `xml:"class"`
			} `xml:"classes"`
		} `xml:"package"`
	} `xml:"packages"`
}

func normalizeCobertura(in Input) (Result, error) {
	var doc coberturaDoc
	if err := xml.Unmarshal(in.Data, &doc); err != nil {
		return Result{}, fmt.Errorf("not valid Cobertura XML: %w", err)
	}
	t := newTotals()
	for _, pkg := range doc.Packages.Packages {
		for _, cls := range pkg.Classes.Classes {
			fc := t.file(relPath(cls.Filename))
			for _, l := range cls.Lines.Lines {
				t.linesFound++
				fc.found++
				if l.Hits > 0 {
					t.linesHit++
					fc.hit++
				}
			}
		}
	}
	return t.result(in.Analyzer, 5), nil
}

func atoi(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}
