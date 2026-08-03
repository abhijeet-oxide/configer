package normalize

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

func init() {
	Register("lighthouse", normalizeLighthouse)
	Register("k6-summary", normalizeK6)
	Register("benchstat-csv", normalizeBenchstat)
	Register("size-limit", normalizeSizeLimit)
}

// --- Lighthouse -------------------------------------------------------------

// The Lighthouse Result (LHR) JSON. Lighthouse is the reference implementation
// of "what does a browser think of this page", and its categories map onto four
// of the platform's quality questions at once: performance, accessibility, best
// practices and SEO.
type lhr struct {
	FinalURL          string `json:"finalUrl"`
	RequestedURL      string `json:"requestedUrl"`
	FinalDisplayedURL string `json:"finalDisplayedUrl"`
	Categories        map[string]struct {
		ID    string   `json:"id"`
		Title string   `json:"title"`
		Score *float64 `json:"score"`
	} `json:"categories"`
	Audits map[string]struct {
		ID               string   `json:"id"`
		Title            string   `json:"title"`
		Description      string   `json:"description"`
		Score            *float64 `json:"score"`
		ScoreDisplayMode string   `json:"scoreDisplayMode"`
		NumericValue     *float64 `json:"numericValue"`
		NumericUnit      string   `json:"numericUnit"`
		DisplayValue     string   `json:"displayValue"`
		Details          struct {
			Items []map[string]any `json:"items"`
		} `json:"details"`
	} `json:"audits"`
}

// coreVitals are the audits worth carrying as first-class metrics. Everything
// else Lighthouse measures stays in the artifact: a report that lists 150 audit
// numbers is a report nobody reads and an agent pays for twice.
var coreVitals = map[string]string{
	"largest-contentful-paint":  "frontend.lighthouse.lcp",
	"cumulative-layout-shift":   "frontend.lighthouse.cls",
	"total-blocking-time":       "frontend.lighthouse.tbt",
	"first-contentful-paint":    "frontend.lighthouse.fcp",
	"speed-index":               "frontend.lighthouse.speed_index",
	"interaction-to-next-paint": "frontend.lighthouse.inp",
	"total-byte-weight":         "frontend.lighthouse.bytes",
}

func normalizeLighthouse(in Input) (Result, error) {
	// Lighthouse CI writes either one LHR or an array of them (one per URL).
	var many []lhr
	if err := json.Unmarshal(in.Data, &many); err != nil {
		var one lhr
		if err2 := json.Unmarshal(in.Data, &one); err2 != nil {
			return Result{}, fmt.Errorf("not a Lighthouse result: %w", err2)
		}
		many = []lhr{one}
	}

	var res Result
	a := in.Analyzer
	for _, r := range many {
		subject := routeOf(firstNonEmpty(r.FinalDisplayedURL, r.FinalURL, r.RequestedURL))
		for id, cat := range r.Categories {
			if cat.Score == nil {
				continue
			}
			m := metric(a, "frontend.lighthouse."+id, cat.Title+" score", *cat.Score*100, "score", model.HigherBetter)
			m.Subject = subject
			res.Metrics = append(res.Metrics, m)
		}
		for id, mid := range coreVitals {
			au, ok := r.Audits[id]
			if !ok || au.NumericValue == nil {
				continue
			}
			unit := strings.ToLower(au.NumericUnit)
			if unit == "millisecond" {
				unit = "ms"
			}
			if unit == "byte" {
				unit = "bytes"
			}
			if unit == "" || unit == "unitless" {
				unit = "score"
			}
			m := metric(a, mid, au.Title, *au.NumericValue, unit, model.LowerBetter)
			m.Subject = subject
			res.Metrics = append(res.Metrics, m)
		}

		// A failing audit is a finding, but only the ones with a real numeric
		// score: "notApplicable" and "informative" audits carry no verdict.
		for id, au := range r.Audits {
			if au.Score == nil || *au.Score >= 0.9 || au.ScoreDisplayMode == "informative" ||
				au.ScoreDisplayMode == "notApplicable" || au.ScoreDisplayMode == "manual" {
				continue
			}
			sev := model.SeverityNote
			if *au.Score < 0.5 {
				sev = model.SeverityWarning
			}
			title := fmt.Sprintf("%s: %s", subject, au.Title)
			if au.DisplayValue != "" {
				title += " (" + au.DisplayValue + ")"
			}
			f := finding(a, "lighthouse/"+id, oneLine(title), sev)
			f.Detail = oneLine(truncate(au.Description, 300))
			f.Where = []model.Location{{Path: "frontend", Component: subject}}
			f.Fix.Recommendation = oneLine(truncate(au.Description, 240))
			f.Fix.SafeToAutomate = false
			f.Tags = append(f.Tags, "frontend-performance")
			res.Findings = append(res.Findings, f)
		}
	}
	return res, nil
}

func routeOf(u string) string {
	if u == "" {
		return "/"
	}
	if i := strings.Index(u, "://"); i >= 0 {
		u = u[i+3:]
	}
	if i := strings.IndexByte(u, '/'); i >= 0 {
		return u[i:]
	}
	return "/"
}

// --- k6 ---------------------------------------------------------------------

// k6's end-of-test summary, as written by handleSummary(). k6 is the load
// generator of choice here because its output is JSON by construction rather
// than by scraping, and because the whole test is a JavaScript file that lives
// in the repository next to the code it exercises.
type k6Summary struct {
	Metrics map[string]struct {
		Type   string             `json:"type"`
		Values map[string]float64 `json:"values"`
	} `json:"metrics"`
	RootGroup any `json:"root_group"`
}

// k6Interesting maps k6's metric names onto the platform's, with the direction
// each one improves in.
var k6Interesting = []struct {
	k6, id, name, stat, unit string
	dir                      model.Direction
}{
	{"http_req_duration", "backend.latency.p95", "Request latency p95", "p(95)", "ms", model.LowerBetter},
	{"http_req_duration", "backend.latency.p99", "Request latency p99", "p(99)", "ms", model.LowerBetter},
	{"http_req_duration", "backend.latency.median", "Request latency median", "med", "ms", model.LowerBetter},
	{"http_req_failed", "backend.error_rate", "Request failure rate", "rate", "percent", model.LowerBetter},
	{"http_reqs", "backend.throughput", "Requests per second", "rate", "rps", model.HigherBetter},
	{"iteration_duration", "backend.iteration.p95", "Scenario duration p95", "p(95)", "ms", model.LowerBetter},
}

func normalizeK6(in Input) (Result, error) {
	var s k6Summary
	if err := json.Unmarshal(in.Data, &s); err != nil {
		return Result{}, fmt.Errorf("not a k6 summary: %w", err)
	}
	var res Result
	a := in.Analyzer
	for _, want := range k6Interesting {
		m, ok := s.Metrics[want.k6]
		if !ok {
			continue
		}
		v, ok := m.Values[want.stat]
		if !ok {
			continue
		}
		if want.unit == "percent" {
			v *= 100
		}
		res.Metrics = append(res.Metrics, metric(a, want.id, want.name, v, want.unit, want.dir))
	}
	// A load test that produced failures is a finding in its own right; the
	// budget engine will decide whether the rate is tolerable.
	if m, ok := s.Metrics["http_req_failed"]; ok {
		if rate := m.Values["rate"]; rate > 0 {
			f := finding(a, "k6/http_req_failed",
				fmt.Sprintf("%.2f%% of requests failed under load", rate*100), model.SeverityError)
			f.Conf = model.ConfidenceHigh
			f.Where = []model.Location{{Path: "backend"}}
			f.Fix.Recommendation = "Check the server log for the failing status codes; a failure rate under load usually means a resource limit, a timeout or an unhandled concurrent path."
			f.Tags = append(f.Tags, "backend-performance")
			res.Findings = append(res.Findings, f)
		}
	}
	return res, nil
}

// --- benchstat --------------------------------------------------------------

// benchstat -format csv over `go test -bench`. benchstat is the right tool
// rather than a hand-rolled comparison because it does the statistics: it knows
// the difference between a benchmark that got slower and one that was noisy,
// and a performance gate built on single runs cries wolf until it is switched
// off.
func normalizeBenchstat(in Input) (Result, error) {
	r := csv.NewReader(strings.NewReader(string(in.Data)))
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		return Result{}, fmt.Errorf("not benchstat CSV: %w", err)
	}
	var res Result
	a := in.Analyzer
	unit := ""
	for _, row := range rows {
		if len(row) == 0 {
			continue
		}
		head := strings.TrimSpace(row[0])
		if head == "" {
			continue
		}
		// benchstat emits a "goos:"/"unit" preamble and a header row before
		// each unit's block; the header names the unit for the rows that follow.
		if strings.HasPrefix(head, "goos:") || strings.HasPrefix(head, "goarch:") || strings.HasPrefix(head, "pkg:") {
			continue
		}
		if len(row) > 1 && isUnitHeader(row) {
			unit = strings.TrimSpace(row[len(row)-1])
			continue
		}
		if len(row) < 2 {
			continue
		}
		v, err := strconv.ParseFloat(strings.TrimSpace(row[1]), 64)
		if err != nil {
			continue
		}
		id, label, u := benchMetric(unit)
		m := metric(a, id, label, v, u, model.LowerBetter)
		m.Subject = strings.TrimSuffix(head, "-8")
		res.Metrics = append(res.Metrics, m)
	}
	return res, nil
}

func isUnitHeader(row []string) bool {
	for _, c := range row {
		switch strings.TrimSpace(c) {
		case "sec/op", "ns/op", "B/op", "allocs/op", "bytes/op":
			return true
		}
	}
	return false
}

func benchMetric(unit string) (id, label, u string) {
	switch strings.TrimSpace(unit) {
	case "B/op", "bytes/op":
		return "backend.bench.bytes_per_op", "Bytes allocated per operation", "bytes"
	case "allocs/op":
		return "backend.bench.allocs_per_op", "Allocations per operation", "count"
	case "sec/op":
		return "backend.bench.sec_per_op", "Seconds per operation", "s"
	default:
		return "backend.bench.ns_per_op", "Nanoseconds per operation", "ns/op"
	}
}

// --- size-limit -------------------------------------------------------------

// size-limit measures what the browser actually pays for: the gzipped or
// brotli'd bytes, and optionally the time to parse and execute them. It is the
// bundle budget tool because it reports a NUMBER rather than a treemap, and a
// number is what a gate can compare.
type sizeLimitEntry struct {
	Name      string   `json:"name"`
	Passed    *bool    `json:"passed"`
	Size      float64  `json:"size"`
	Running   *float64 `json:"running"`
	Loading   *float64 `json:"loading"`
	Total     *float64 `json:"total"`
	SizeLimit *float64 `json:"sizeLimit"`
}

func normalizeSizeLimit(in Input) (Result, error) {
	var entries []sizeLimitEntry
	if err := json.Unmarshal(in.Data, &entries); err != nil {
		return Result{}, fmt.Errorf("not a size-limit report: %w", err)
	}
	var res Result
	a := in.Analyzer
	var total float64
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	for _, e := range entries {
		total += e.Size
		m := metric(a, "frontend.bundle.gzip", "Bundle size (gzip)", e.Size, "bytes", model.LowerBetter)
		m.Subject = e.Name
		res.Metrics = append(res.Metrics, m)
		if e.SizeLimit != nil && e.Size > *e.SizeLimit {
			f := finding(a, "size-limit/exceeded",
				fmt.Sprintf("%s is %s, over its %s limit", e.Name,
					model.Metric{Unit: "bytes"}.Format(e.Size),
					model.Metric{Unit: "bytes"}.Format(*e.SizeLimit)),
				model.SeverityError)
			f.Conf = model.ConfidenceHigh
			f.Where = []model.Location{{Path: "frontend", Component: e.Name}}
			f.Fix.Recommendation = "Look at what the entry point newly pulls in. A dependency imported at module scope for a rarely used screen belongs behind a dynamic import."
			f.Tags = append(f.Tags, "bundle-regression")
			res.Findings = append(res.Findings, f)
		}
	}
	res.Metrics = append(res.Metrics,
		metric(a, "frontend.bundle.total_gzip", "Total bundle size (gzip)", total, "bytes", model.LowerBetter))
	return res, nil
}
