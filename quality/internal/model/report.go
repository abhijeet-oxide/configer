package model

import (
	"sort"
	"time"
)

// SchemaVersion is the contract between the platform and everything that reads
// its output, agents included. It is semver: a consumer may rely on the minor
// version adding fields and never removing them.
const SchemaVersion = "1.0.0"

// Verdict is the one word a pipeline, a reviewer or an agent acts on.
type Verdict string

const (
	VerdictPass  Verdict = "pass"  // nothing blocking; merge
	VerdictWarn  Verdict = "warn"  // findings worth reading, nothing blocking
	VerdictFail  Verdict = "fail"  // a budget was breached; do not merge
	VerdictError Verdict = "error" // the platform itself could not finish
)

// Tier is where in the developer's day a run happens. It is the primary dial on
// cost: the same analyzers, a different subset, a different budget for time.
type Tier string

const (
	TierLocal     Tier = "local"      // seconds; formatting, types
	TierPreCommit Tier = "pre-commit" // under ~90s; changed files only
	TierPR        Tier = "pr"         // minutes; everything the diff can affect
	TierMain      Tier = "main"       // the full sweep, after merge
	TierNightly   Tier = "nightly"    // the expensive long tail
)

// AllTiers is ordered cheapest first; a tier always includes the work of the
// tiers before it, which is why the order is load-bearing.
var AllTiers = []Tier{TierLocal, TierPreCommit, TierPR, TierMain, TierNightly}

// Includes reports whether running at tier t also runs the work of tier other.
func (t Tier) Includes(other Tier) bool { return tierRank(t) >= tierRank(other) }

func tierRank(t Tier) int {
	for i, x := range AllTiers {
		if x == t {
			return i
		}
	}
	return -1
}

// AnalyzerRun records what one analyzer did. It is the platform's own
// observability, in the report rather than only in a trace, because "why did
// this take four minutes" is asked far more often from the artifact than from a
// dashboard.
type AnalyzerRun struct {
	ID         string   `json:"id"`
	Category   Category `json:"category"`
	Status     string   `json:"status"` // ok | findings | failed | skipped | cached | missing-tool
	Reason     string   `json:"reason,omitempty"`
	DurationMS int64    `json:"durationMs"`
	CacheHit   bool     `json:"cacheHit"`
	Findings   int      `json:"findings"`
	Metrics    int      `json:"metrics"`
	ExitCode   int      `json:"exitCode,omitempty"`
	// Artifact is the repo-relative path to this analyzer's raw output. The
	// report never inlines a log; it points at one.
	Artifact string `json:"artifact,omitempty"`
	Tool     string `json:"tool,omitempty"`
	Version  string `json:"toolVersion,omitempty"`
}

// Selection explains why the run did what it did. An agent that is told "the
// bundle check did not run" must be able to see that no frontend file changed,
// rather than assume the platform is broken.
type Selection struct {
	Tier         Tier     `json:"tier"`
	ChangedFiles int      `json:"changedFiles"`
	BaseRef      string   `json:"baseRef,omitempty"`
	Scopes       []string `json:"scopes"` // frontend, backend, api, infra, docs, deps, ci
	Selected     []string `json:"selected"`
	Skipped      []string `json:"skipped,omitempty"`
	Reason       string   `json:"reason,omitempty"`
}

// Summary is the part an agent reads first and, on a clean run, the only part
// it needs to read at all.
type Summary struct {
	Verdict     Verdict        `json:"verdict"`
	Score       int            `json:"score"` // 0..100
	ScoreDelta  *int           `json:"scoreDelta,omitempty"`
	Trend       string         `json:"trend,omitempty"` // improved | flat | regressed
	Headline    string         `json:"headline"`        // one sentence, plain words
	Counts      map[string]int `json:"counts"`          // by severity
	NewFindings int            `json:"newFindings"`
	FixedSince  int            `json:"fixedSinceBaseline"`
	BlockedBy   []string       `json:"blockedBy,omitempty"` // budget names that failed
	NextSteps   []string       `json:"nextSteps,omitempty"`
}

// CategoryReport is the per-area rollup. Score is comparable across categories
// so a bar chart of them is meaningful.
type CategoryReport struct {
	Category Category       `json:"category"`
	Score    int            `json:"score"`
	Verdict  Verdict        `json:"verdict"`
	Counts   map[string]int `json:"counts"`
	Findings int            `json:"findings"`
	Metrics  int            `json:"metrics"`
}

// RunMeta is the provenance of a report: enough to reproduce it and enough to
// line two reports up against each other.
type RunMeta struct {
	ID         string    `json:"id"`
	StartedAt  time.Time `json:"startedAt"`
	DurationMS int64     `json:"durationMs"`
	Commit     string    `json:"commit,omitempty"`
	Branch     string    `json:"branch,omitempty"`
	BaseRef    string    `json:"baseRef,omitempty"`
	PR         string    `json:"pr,omitempty"`
	Repo       string    `json:"repo,omitempty"`
	CI         string    `json:"ci,omitempty"` // github-actions | azure-devops | local
	Platform   string    `json:"platform"`
	CacheHits  int       `json:"cacheHits"`
	CacheMiss  int       `json:"cacheMisses"`
	Parallel   int       `json:"parallelism"`
}

// Artifact is a pointer to detail deliberately left out of the report. The
// report is the contract; artifacts are where the megabytes live.
type Artifact struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Kind     string `json:"kind"` // sarif | junit | lcov | cyclonedx | html | json | log
	Analyzer string `json:"analyzer,omitempty"`
	Bytes    int64  `json:"bytes,omitempty"`
}

// Report is the single normalized document the whole platform exists to
// produce. Field order here is the JSON field order, and it is chosen for a
// reader that stops early: verdict and summary first, raw detail last.
type Report struct {
	Schema     string           `json:"schema"`
	Meta       RunMeta          `json:"run"`
	Summary    Summary          `json:"summary"`
	Selection  Selection        `json:"selection"`
	Budgets    []BudgetResult   `json:"budgets"`
	Categories []CategoryReport `json:"categories"`
	Findings   []Finding        `json:"findings"`
	Metrics    []Metric         `json:"metrics"`
	Analyzers  []AnalyzerRun    `json:"analyzers"`
	Artifacts  []Artifact       `json:"artifacts,omitempty"`
	// Errors are the platform's own failures, kept apart from findings so a
	// broken analyzer never masquerades as a code problem.
	Errors []string `json:"platformErrors,omitempty"`
}

// Sort puts a report in canonical order so two runs over identical code produce
// identical bytes and the report itself diffs cleanly.
func (r *Report) Sort() {
	SortFindings(r.Findings)
	sort.SliceStable(r.Metrics, func(i, j int) bool { return r.Metrics[i].Key() < r.Metrics[j].Key() })
	sort.SliceStable(r.Analyzers, func(i, j int) bool { return r.Analyzers[i].ID < r.Analyzers[j].ID })
	sort.SliceStable(r.Budgets, func(i, j int) bool {
		a, b := r.Budgets[i], r.Budgets[j]
		if a.Status != b.Status {
			return budgetOrder(a.Status) < budgetOrder(b.Status)
		}
		return a.Budget < b.Budget
	})
	sort.SliceStable(r.Artifacts, func(i, j int) bool { return r.Artifacts[i].Path < r.Artifacts[j].Path })
}

func budgetOrder(s BudgetStatus) int {
	switch s {
	case BudgetFail:
		return 0
	case BudgetWarn:
		return 1
	case BudgetPass:
		return 2
	default:
		return 3
	}
}

// FailedBudgets returns the budgets that block a merge.
func (r *Report) FailedBudgets() []BudgetResult {
	var out []BudgetResult
	for _, b := range r.Budgets {
		if b.Failed() {
			out = append(out, b)
		}
	}
	return out
}

// ExitCode is the process status the CLI returns: 0 clean, 1 gate failed,
// 2 the platform itself broke. Nothing else, so a pipeline can branch on it.
func (r *Report) ExitCode() int {
	switch r.Summary.Verdict {
	case VerdictFail:
		return 1
	case VerdictError:
		return 2
	default:
		return 0
	}
}
