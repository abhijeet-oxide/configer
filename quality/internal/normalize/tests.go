package normalize

import (
	"encoding/xml"
	"fmt"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

func init() {
	Register("junit", normalizeJUnit)
}

// JUnit XML is the lingua franca of test results: Playwright, Vitest, Jest,
// gotestsum, pytest, Schemathesis and every CI system on the planet read or
// write it. One normalizer, every test runner.
type junitSuites struct {
	XMLName  xml.Name     `xml:"testsuites"`
	Name     string       `xml:"name,attr"`
	Suites   []junitSuite `xml:"testsuite"`
	Tests    int          `xml:"tests,attr"`
	Failures int          `xml:"failures,attr"`
	Errors   int          `xml:"errors,attr"`
	Skipped  int          `xml:"skipped,attr"`
	Time     float64      `xml:"time,attr"`
}

type junitSuite struct {
	Name     string       `xml:"name,attr"`
	Tests    int          `xml:"tests,attr"`
	Failures int          `xml:"failures,attr"`
	Errors   int          `xml:"errors,attr"`
	Skipped  int          `xml:"skipped,attr"`
	Time     float64      `xml:"time,attr"`
	File     string       `xml:"file,attr"`
	Cases    []junitCase  `xml:"testcase"`
	Suites   []junitSuite `xml:"testsuite"`
}

type junitCase struct {
	Name      string         `xml:"name,attr"`
	ClassName string         `xml:"classname,attr"`
	File      string         `xml:"file,attr"`
	Line      int            `xml:"line,attr"`
	Time      float64        `xml:"time,attr"`
	Failures  []junitProblem `xml:"failure"`
	Errors    []junitProblem `xml:"error"`
	Skipped   *struct {
		Message string `xml:"message,attr"`
	} `xml:"skipped"`
	// Playwright and others record a retry that eventually passed; a test that
	// needed a retry is the definition of flaky, and it is the only place in
	// the whole platform where flakiness can be observed for free.
	Flaky     *struct{} `xml:"flaky"`
	SystemOut string    `xml:"system-out"`
}

type junitProblem struct {
	Message string `xml:"message,attr"`
	Type    string `xml:"type,attr"`
	Text    string `xml:",chardata"`
}

func normalizeJUnit(in Input) (Result, error) {
	data := strings.TrimSpace(string(in.Data))
	if data == "" {
		return Result{}, nil
	}
	var doc junitSuites
	if err := xml.Unmarshal([]byte(data), &doc); err != nil {
		// A runner that emits a bare <testsuite> root rather than <testsuites>
		// is common enough that failing on it would be a papercut.
		var single junitSuite
		if err2 := xml.Unmarshal([]byte(data), &single); err2 != nil {
			return Result{}, fmt.Errorf("not valid JUnit XML: %w", err)
		}
		doc.Suites = []junitSuite{single}
	}

	var res Result
	var total, failed, skipped, flaky int
	var duration float64

	var walk func(s junitSuite, path string)
	walk = func(s junitSuite, path string) {
		name := strings.TrimSpace(s.Name)
		if path != "" && name != "" {
			name = path + " > " + name
		} else if name == "" {
			name = path
		}
		duration += s.Time
		for _, c := range s.Cases {
			total++
			if c.Skipped != nil {
				skipped++
				continue
			}
			if c.Flaky != nil {
				flaky++
			}
			problems := append(append([]junitProblem{}, c.Failures...), c.Errors...)
			if len(problems) == 0 {
				continue
			}
			failed++
			p := problems[0]
			loc := model.Location{Path: firstNonEmpty(c.File, s.File), Line: c.Line, Symbol: c.Name}
			title := fmt.Sprintf("Test failed: %s", testLabel(c, name))
			f := finding(in.Analyzer, firstNonEmpty(p.Type, "test.failure"), title, model.SeverityError, loc)
			f.Detail = oneLine(truncate(firstNonEmpty(p.Message, p.Text), 400))
			f.Evidence = truncate(firstLineOf(p.Text), 200)
			f.Conf = model.ConfidenceHigh
			if f.Fix.Recommendation == "" {
				f.Fix.Recommendation = "Reproduce the failing test locally and fix the behaviour it asserts, or update the assertion if the new behaviour is intended."
			}
			res.Findings = append(res.Findings, f)
		}
		for _, child := range s.Suites {
			walk(child, name)
		}
	}
	for _, s := range doc.Suites {
		walk(s, "")
	}

	a := in.Analyzer
	res.Metrics = append(res.Metrics,
		metric(a, "tests.total", "Tests run", float64(total), "count", model.HigherBetter),
		metric(a, "tests.failed", "Tests failed", float64(failed), "count", model.LowerBetter),
		metric(a, "tests.skipped", "Tests skipped", float64(skipped), "count", model.LowerBetter),
		metric(a, "tests.flaky", "Flaky tests (passed only on retry)", float64(flaky), "count", model.LowerBetter),
		metric(a, "tests.duration", "Test suite duration", duration*1000, "ms", model.LowerBetter),
	)
	if flaky > 0 {
		f := finding(a, "test.flaky",
			fmt.Sprintf("%d test(s) passed only after a retry", flaky), model.SeverityWarning)
		f.Conf = model.ConfidenceHigh
		f.Tags = append(f.Tags, "flaky-tests")
		f.Fix.Recommendation = "A test that needs a retry is hiding a real race or an unawaited effect. Find the wait it is missing rather than raising the retry count."
		f.Fix.SafeToAutomate = false
		res.Findings = append(res.Findings, f)
	}
	return res, nil
}

func testLabel(c junitCase, suite string) string {
	name := firstNonEmpty(c.Name, "unnamed test")
	if c.ClassName != "" && !strings.Contains(name, c.ClassName) {
		return c.ClassName + " / " + name
	}
	if suite != "" {
		return suite + " / " + name
	}
	return name
}

func firstLineOf(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}
