package normalize

import (
	"bufio"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

func init() {
	Register("go-test-json", normalizeGoTestJSON)
}

// `go test -json` events. This normalizer exists rather than routing Go tests
// through JUnit because the interesting Go signals are not in the pass/fail
// column: the race detector, `go vet`'s findings and goroutine-leak reports all
// arrive as OUTPUT text on an otherwise ordinary failing test, and a JUnit
// conversion throws exactly that away.
type goTestEvent struct {
	Action  string  `json:"Action"` // run, output, pass, fail, skip
	Package string  `json:"Package"`
	Test    string  `json:"Test"`
	Elapsed float64 `json:"Elapsed"`
	Output  string  `json:"Output"`
}

func normalizeGoTestJSON(in Input) (Result, error) {
	sc := bufio.NewScanner(strings.NewReader(string(in.Data)))
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)

	type testKey struct{ pkg, test string }
	output := map[testKey][]string{}
	failed := map[testKey]bool{}
	var passed, skipped, total int
	var elapsed float64
	var pkgFailed []string

	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || line[0] != '{' {
			continue
		}
		var e goTestEvent
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			continue
		}
		k := testKey{e.Package, e.Test}
		switch e.Action {
		case "output":
			output[k] = append(output[k], e.Output)
		case "pass":
			if e.Test != "" {
				passed++
				total++
			}
			elapsed += e.Elapsed
		case "skip":
			if e.Test != "" {
				skipped++
				total++
			}
		case "fail":
			if e.Test != "" {
				failed[k] = true
				total++
			} else {
				pkgFailed = append(pkgFailed, e.Package)
			}
		}
	}
	if err := sc.Err(); err != nil {
		return Result{}, err
	}

	var res Result
	a := in.Analyzer
	races, leaks := 0, 0

	keys := make([]testKey, 0, len(failed))
	for k := range failed {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].pkg != keys[j].pkg {
			return keys[i].pkg < keys[j].pkg
		}
		return keys[i].test < keys[j].test
	})

	for _, k := range keys {
		text := strings.Join(output[k], "")
		loc := model.Location{Path: goPackagePath(k.pkg), Symbol: k.test}
		if file, line := failureSite(text); file != "" {
			loc.Path = goPackagePath(k.pkg) + "/" + file
			loc.Line = line
		}

		// A data race is not a failing test, it is a defect in the code the
		// test happened to exercise, and it deserves its own finding at its own
		// severity. Detecting it here is what makes "no races" a real budget.
		switch {
		case strings.Contains(text, "WARNING: DATA RACE"):
			races++
			f := finding(a, "go/data-race",
				fmt.Sprintf("Data race detected in %s", shortTest(k.pkg, k.test)),
				model.SeverityBlocker, loc)
			f.Conf = model.ConfidenceHigh
			f.Evidence = truncate(raceSummary(text), 300)
			f.Fix.Recommendation = "Two goroutines touch the same memory with no ordering between them. Guard it with a mutex, or hand ownership over a channel; do not add a sleep."
			f.Fix.SafeToAutomate = false
			f.Fix.Effort = "medium"
			f.Tags = append(f.Tags, "race", "backend-performance")
			res.Findings = append(res.Findings, f)
			continue
		case strings.Contains(text, "found unexpected goroutines"), strings.Contains(text, "leaked goroutine"):
			leaks++
			f := finding(a, "go/goroutine-leak",
				fmt.Sprintf("Goroutine leak in %s", shortTest(k.pkg, k.test)),
				model.SeverityError, loc)
			f.Conf = model.ConfidenceHigh
			f.Evidence = truncate(firstMatch(text, "goroutine"), 300)
			f.Fix.Recommendation = "Every goroutine needs a way out. Give it a context or a done channel, and wait for it before the function that started it returns."
			f.Fix.SafeToAutomate = false
			f.Fix.Effort = "small"
			f.Tags = append(f.Tags, "goroutine-leak")
			res.Findings = append(res.Findings, f)
			continue
		case strings.Contains(text, "all goroutines are asleep - deadlock"):
			f := finding(a, "go/deadlock",
				fmt.Sprintf("Deadlock in %s", shortTest(k.pkg, k.test)), model.SeverityBlocker, loc)
			f.Conf = model.ConfidenceHigh
			f.Evidence = truncate(firstMatch(text, "deadlock"), 300)
			f.Fix.Recommendation = "Every goroutine is blocked. Look for a channel nobody reads, or two locks taken in opposite orders."
			f.Fix.SafeToAutomate = false
			res.Findings = append(res.Findings, f)
			continue
		}

		f := finding(a, "go/test-failure",
			fmt.Sprintf("Test failed: %s", shortTest(k.pkg, k.test)), model.SeverityError, loc)
		f.Conf = model.ConfidenceHigh
		f.Evidence = truncate(assertionLine(text), 300)
		f.Fix.Recommendation = "Run `go test -run " + k.test + " ./" + goPackagePath(k.pkg) + "` and fix the behaviour, or update the assertion if the new behaviour is intended."
		f.Fix.SafeToAutomate = false
		res.Findings = append(res.Findings, f)
	}

	// A package that failed to build reports no test events at all, so without
	// this the run would look clean.
	sort.Strings(pkgFailed)
	for _, pkg := range pkgFailed {
		text := strings.Join(output[testKey{pkg, ""}], "")
		if !strings.Contains(text, "build failed") && !strings.Contains(text, "[build failed]") &&
			!strings.Contains(text, "setup failed") {
			continue
		}
		f := finding(a, "go/build-failure",
			fmt.Sprintf("Package %s does not build", goPackagePath(pkg)),
			model.SeverityBlocker, model.Location{Path: goPackagePath(pkg)})
		f.Conf = model.ConfidenceHigh
		f.Evidence = truncate(lastLines(text, 3), 300)
		f.Fix.Recommendation = "Fix the compile error; nothing downstream of this package was measured."
		res.Findings = append(res.Findings, f)
	}

	res.Metrics = append(res.Metrics,
		metric(a, "tests.total", "Tests run", float64(total), "count", model.HigherBetter),
		metric(a, "tests.failed", "Tests failed", float64(len(failed)), "count", model.LowerBetter),
		metric(a, "tests.skipped", "Tests skipped", float64(skipped), "count", model.LowerBetter),
		metric(a, "tests.duration", "Test suite duration", elapsed*1000, "ms", model.LowerBetter),
		metric(a, "backend.races", "Data races detected", float64(races), "count", model.LowerBetter),
		metric(a, "backend.goroutine_leaks", "Goroutine leaks detected", float64(leaks), "count", model.LowerBetter))
	return res, nil
}

// goPackagePath turns an import path into a repository-relative directory so
// the finding is clickable.
func goPackagePath(pkg string) string {
	parts := strings.Split(pkg, "/")
	if len(parts) > 3 && strings.Contains(parts[0], ".") {
		return strings.Join(parts[3:], "/")
	}
	return pkg
}

func shortTest(pkg, test string) string {
	if test == "" {
		return goPackagePath(pkg)
	}
	return goPackagePath(pkg) + "." + test
}

// failureSite finds the "    file_test.go:42:" prefix Go prints for a failed
// assertion, which is the line a reader actually wants to open.
func failureSite(text string) (string, int) {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		i := strings.Index(line, ".go:")
		if i < 0 {
			continue
		}
		file := line[:i+3]
		if j := strings.LastIndexAny(file, " \t"); j >= 0 {
			file = file[j+1:]
		}
		rest := line[i+4:]
		num := 0
		for _, r := range rest {
			if r < '0' || r > '9' {
				break
			}
			num = num*10 + int(r-'0')
		}
		if num > 0 && !strings.Contains(file, "/") {
			return file, num
		}
	}
	return "", 0
}

func assertionLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "---") || t == "" || strings.HasPrefix(t, "===") {
			continue
		}
		if strings.Contains(t, ".go:") || strings.Contains(strings.ToLower(t), "want") ||
			strings.Contains(strings.ToLower(t), "expected") || strings.Contains(t, "got") {
			return t
		}
	}
	return lastLines(text, 2)
}

func raceSummary(text string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if strings.Contains(line, "DATA RACE") {
			end := i + 4
			if end > len(lines) {
				end = len(lines)
			}
			return strings.Join(lines[i:end], " | ")
		}
	}
	return firstLineOf(text)
}

func firstMatch(text, needle string) string {
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, needle) {
			return strings.TrimSpace(line)
		}
	}
	return firstLineOf(text)
}
