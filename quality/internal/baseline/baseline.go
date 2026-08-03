// Package baseline is what makes regression-based validation possible: it
// remembers what the code looked like last time it was known good, so a gate
// can ask "is this worse" instead of "is this perfect".
//
// A fixed threshold is either unreachable on the day it is introduced or
// meaningless a year later. A baseline comparison is neither, and it is the
// reason a team can adopt this platform on a repository that already has debt.
package baseline

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

// Baseline is the reduced form of a previous report. It stores only what a
// comparison needs: metric values and finding fingerprints. Keeping it small
// matters because it is fetched on every run, often from a CI cache.
type Baseline struct {
	Schema     string             `json:"schema"`
	Commit     string             `json:"commit,omitempty"`
	Branch     string             `json:"branch,omitempty"`
	RecordedAt time.Time          `json:"recordedAt"`
	Score      int                `json:"score"`
	Metrics    map[string]float64 `json:"metrics"`
	// Findings maps fingerprint to severity, so the comparison can tell a new
	// error from a new note without storing the whole finding.
	Findings map[string]string `json:"findings"`
}

// FromReport reduces a report to a baseline.
func FromReport(r *model.Report) *Baseline {
	b := &Baseline{
		Schema:     model.SchemaVersion,
		Commit:     r.Meta.Commit,
		Branch:     r.Meta.Branch,
		RecordedAt: time.Now().UTC(),
		Score:      r.Summary.Score,
		Metrics:    map[string]float64{},
		Findings:   map[string]string{},
	}
	for _, m := range r.Metrics {
		b.Metrics[m.Key()] = m.Value
	}
	for _, f := range r.Findings {
		b.Findings[f.Fingerprint] = string(f.Severity)
	}
	return b
}

// Load reads a baseline. A missing baseline is not an error: the first run on a
// new branch has nothing to compare against, and every regression budget
// correctly reports "skip" rather than inventing a comparison.
func Load(path string) (*Baseline, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var bl Baseline
	if err := json.Unmarshal(b, &bl); err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	if bl.Metrics == nil {
		bl.Metrics = map[string]float64{}
	}
	if bl.Findings == nil {
		bl.Findings = map[string]string{}
	}
	return &bl, nil
}

// Save writes a baseline atomically.
func Save(path string, b *Baseline) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Metric returns a baseline value.
func (b *Baseline) Metric(key string) (float64, bool) {
	if b == nil {
		return 0, false
	}
	v, ok := b.Metrics[key]
	return v, ok
}

// Comparison is the result of holding a run up against its baseline.
type Comparison struct {
	Present    bool
	NewCount   int
	FixedCount int
	ScoreDelta int
	Trend      string
	// Fixed lists the fingerprints that were in the baseline and are gone. They
	// are reported because a pull request that removes debt deserves to be told
	// so; a platform that only ever says "worse" gets resented and then ignored.
	Fixed []string
}

// Apply marks the findings that are new against the baseline and returns the
// comparison. It mutates the findings in place because "new" is a property of
// this run, not of the finding, and every reporter needs it.
func Apply(findings []model.Finding, b *Baseline, currentScore int) Comparison {
	if b == nil {
		// With no baseline every finding is technically new, but saying so
		// would be noise: the honest answer is that newness is unknown, and the
		// report says the baseline is absent instead.
		return Comparison{Present: false, Trend: "unknown"}
	}
	c := Comparison{Present: true}
	seen := map[string]bool{}
	for i := range findings {
		fp := findings[i].Fingerprint
		seen[fp] = true
		if _, existed := b.Findings[fp]; !existed {
			findings[i].New = true
			c.NewCount++
		}
	}
	for fp := range b.Findings {
		if !seen[fp] {
			c.FixedCount++
			c.Fixed = append(c.Fixed, fp)
		}
	}
	sort.Strings(c.Fixed)
	c.ScoreDelta = currentScore - b.Score
	switch {
	case c.ScoreDelta > 0:
		c.Trend = "improved"
	case c.ScoreDelta < 0:
		c.Trend = "regressed"
	default:
		c.Trend = "flat"
	}
	return c
}

// Path is where a baseline for a given ref lives. Keying by ref rather than
// keeping one file lets a pull request compare against its own base branch,
// which is the only comparison that is actually the change's responsibility.
func Path(dir, ref string) string {
	if ref == "" {
		ref = "default"
	}
	return filepath.Join(dir, "baselines", sanitize(ref)+".json")
}

func sanitize(ref string) string {
	out := make([]rune, 0, len(ref))
	for _, r := range ref {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '.', r == '_':
			out = append(out, r)
		default:
			out = append(out, '-')
		}
	}
	return string(out)
}
