package model

import (
	"fmt"
	"math"
	"strings"
)

// Direction says which way is good. Everything regression-related reads it, so
// no budget ever has to restate whether smaller is better.
type Direction string

const (
	LowerBetter  Direction = "lower_is_better"
	HigherBetter Direction = "higher_is_better"
)

// Metric is a measured number. Findings say "this is wrong"; metrics say "this
// is how much", and only metrics can be compared against a previous build.
// Regression-based gating lives entirely on this type.
type Metric struct {
	ID        string    `json:"id"`   // stable slug, e.g. frontend.bundle.total_gzip
	Name      string    `json:"name"` // human label
	Value     float64   `json:"value"`
	Unit      string    `json:"unit"`      // bytes | ms | percent | count | score | rps
	Direction Direction `json:"direction"` // omitted defaults to lower_is_better
	Analyzer  string    `json:"analyzer"`
	Category  Category  `json:"category"`
	// Subject distinguishes the same metric measured over different things:
	// one route's Lighthouse score, one benchmark's ns/op, one asset's size.
	Subject string `json:"subject,omitempty"`
}

// Key is the identity used to line a metric up with its baseline counterpart.
func (m Metric) Key() string {
	if m.Subject == "" {
		return m.ID
	}
	return m.ID + "|" + m.Subject
}

// Better reports whether a is a better value than b for this metric.
func (m Metric) Better(a, b float64) bool {
	if m.Direction == HigherBetter {
		return a > b
	}
	return a < b
}

// Format renders a value the way a human expects to read that unit.
func (m Metric) Format(v float64) string {
	switch m.Unit {
	case "bytes":
		return humanBytes(v)
	case "ms":
		if v >= 1000 {
			return fmt.Sprintf("%.2fs", v/1000)
		}
		return fmt.Sprintf("%.0fms", v)
	case "percent":
		return fmt.Sprintf("%.1f%%", v)
	case "count":
		return fmt.Sprintf("%.0f", v)
	case "ns/op":
		return fmt.Sprintf("%.0f ns/op", v)
	default:
		if v == math.Trunc(v) && math.Abs(v) < 1e9 {
			return fmt.Sprintf("%.0f", v)
		}
		return fmt.Sprintf("%.2f", v)
	}
}

func humanBytes(v float64) string {
	const unit = 1024
	if v < unit {
		return fmt.Sprintf("%.0f B", v)
	}
	div, exp := float64(unit), 0
	for n := v / unit; n >= unit && exp < 3; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.2f %cB", v/div, "KMGT"[exp])
}

// BudgetStatus is the verdict for one budget.
type BudgetStatus string

const (
	BudgetPass BudgetStatus = "pass"
	BudgetWarn BudgetStatus = "warn"
	BudgetFail BudgetStatus = "fail"
	// BudgetSkip means the metric this budget guards was not produced by this
	// run. That is a state, not a failure: a documentation-only change does not
	// measure the bundle, and pretending it regressed would be a lie.
	BudgetSkip BudgetStatus = "skip"
)

// BudgetResult is one evaluated quality gate. It carries enough context that a
// failure message can be written without going back to the metrics table, which
// is what lets the Markdown summary and the agent read the same object.
type BudgetResult struct {
	Budget    string       `json:"budget"`
	MetricKey string       `json:"metric"`
	Category  Category     `json:"category"`
	Status    BudgetStatus `json:"status"`
	Value     *float64     `json:"value,omitempty"`
	Baseline  *float64     `json:"baseline,omitempty"`
	Limit     string       `json:"limit"`           // the rule in words: "<= 85%" or "growth <= 5%"
	Delta     *float64     `json:"delta,omitempty"` // value - baseline
	DeltaPct  *float64     `json:"deltaPct,omitempty"`
	Message   string       `json:"message"`
	Blocking  bool         `json:"blocking"`
	// Owner points a failure at the analyzer that can explain it.
	Analyzer string `json:"analyzer,omitempty"`
}

// Failed reports whether this budget should stop a merge.
func (b BudgetResult) Failed() bool { return b.Status == BudgetFail && b.Blocking }

// TrendOf describes a metric's movement against the baseline in one word.
func TrendOf(m Metric, cur, base float64) string {
	if math.Abs(cur-base) < 1e-9 {
		return "flat"
	}
	if m.Better(cur, base) {
		return "improved"
	}
	return "regressed"
}

// MetricIndex is a lookup of metrics by Key, used by the policy engine and the
// baseline comparison.
type MetricIndex map[string]Metric

// IndexMetrics builds a MetricIndex, last write winning so a re-run of an
// analyzer replaces rather than duplicates its measurements.
func IndexMetrics(ms []Metric) MetricIndex {
	idx := make(MetricIndex, len(ms))
	for _, m := range ms {
		idx[m.Key()] = m
	}
	return idx
}

// MatchKey resolves a budget's metric selector against the index. A selector
// may name an exact key, or end in "*" to cover every subject of a metric (one
// budget for every route's Lighthouse score, one for every benchmark).
func (idx MetricIndex) MatchKey(selector string) []Metric {
	if !strings.HasSuffix(selector, "*") {
		if m, ok := idx[selector]; ok {
			return []Metric{m}
		}
		return nil
	}
	prefix := strings.TrimSuffix(selector, "*")
	var out []Metric
	for k, m := range idx {
		if strings.HasPrefix(k, prefix) {
			out = append(out, m)
		}
	}
	return out
}
