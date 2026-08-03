// Package spec loads cq.yaml, the one file a repository writes to describe what
// quality means to it. Everything configurable lives here; nothing configurable
// lives in Go.
package spec

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

// FindingSelector picks a set of findings for a budget to count.
type FindingSelector struct {
	Category    model.Category `yaml:"category" json:"category,omitempty"`
	MinSeverity model.Severity `yaml:"minSeverity" json:"minSeverity,omitempty"`
	Analyzer    string         `yaml:"analyzer" json:"analyzer,omitempty"`
	Tag         string         `yaml:"tag" json:"tag,omitempty"`
	// OnlyNew counts only findings absent from the baseline. This is what makes
	// a budget adoptable on a repository that already has debt: the gate holds
	// the line without demanding the backlog be cleared first.
	OnlyNew bool `yaml:"onlyNew" json:"onlyNew,omitempty"`
}

// Budget is one quality gate. A budget is either absolute (Max/Min) or
// regression-based (MaxIncrease*/MaxDecrease*), and the platform prefers the
// latter: a fixed threshold is either unreachable on day one or meaningless on
// day one hundred, whereas "not worse than the branch you are merging into" is
// always both achievable and meaningful.
type Budget struct {
	Name        string           `yaml:"name" json:"name"`
	Description string           `yaml:"description" json:"description,omitempty"`
	Metric      string           `yaml:"metric" json:"metric,omitempty"`
	Findings    *FindingSelector `yaml:"findings" json:"findings,omitempty"`

	Max *float64 `yaml:"max" json:"max,omitempty"`
	Min *float64 `yaml:"min" json:"min,omitempty"`

	MaxIncrease    *float64 `yaml:"maxIncrease" json:"maxIncrease,omitempty"`
	MaxIncreasePct *float64 `yaml:"maxIncreasePct" json:"maxIncreasePct,omitempty"`
	MaxDecrease    *float64 `yaml:"maxDecrease" json:"maxDecrease,omitempty"`
	MaxDecreasePct *float64 `yaml:"maxDecreasePct" json:"maxDecreasePct,omitempty"`

	// WarnAt softens a budget: crossing it is reported, crossing Max fails.
	WarnAt *float64 `yaml:"warnAt" json:"warnAt,omitempty"`

	// Blocking defaults to true. A non-blocking budget is how a new gate is
	// introduced: measured and reported for a while before it can stop a merge.
	Blocking *bool `yaml:"blocking" json:"blocking,omitempty"`
	// Tiers restricts where the budget applies. Empty means every tier that
	// produces the metric.
	Tiers []model.Tier `yaml:"tiers" json:"tiers,omitempty"`
	// Category labels the budget in the report when it is metric-driven.
	Category model.Category `yaml:"category" json:"category,omitempty"`
}

// IsBlocking reports the effective blocking state (default true).
func (b Budget) IsBlocking() bool { return b.Blocking == nil || *b.Blocking }

// AppliesAt reports whether the budget is evaluated at the given tier.
func (b Budget) AppliesAt(t model.Tier) bool {
	if len(b.Tiers) == 0 {
		return true
	}
	for _, x := range b.Tiers {
		if x == t {
			return true
		}
	}
	return false
}

// Validate rejects a budget that says nothing, which would otherwise pass
// silently forever and give false assurance.
func (b Budget) Validate() error {
	if b.Name == "" {
		return fmt.Errorf("budget has no name")
	}
	if b.Metric == "" && b.Findings == nil {
		return fmt.Errorf("budget %q: needs either metric or findings", b.Name)
	}
	if b.Metric != "" && b.Findings != nil {
		return fmt.Errorf("budget %q: set metric or findings, not both", b.Name)
	}
	if b.Max == nil && b.Min == nil && b.MaxIncrease == nil && b.MaxIncreasePct == nil &&
		b.MaxDecrease == nil && b.MaxDecreasePct == nil {
		return fmt.Errorf("budget %q: no limit set, so it can never fail", b.Name)
	}
	return nil
}

// Scoring turns findings and budgets into the 0..100 headline number. The
// weights are configurable because "what counts as bad here" is a property of
// the repository, not of the platform.
type Scoring struct {
	// Penalty per finding, by severity, subtracted from 100 per category.
	Penalty map[string]float64 `yaml:"penalty" json:"penalty"`
	// BudgetFailPenalty is subtracted once per failed blocking budget.
	BudgetFailPenalty float64 `yaml:"budgetFailPenalty" json:"budgetFailPenalty"`
	// CategoryWeights weight the overall score. Missing categories weigh 1.
	CategoryWeights map[string]float64 `yaml:"categoryWeights" json:"categoryWeights,omitempty"`
	// Floor stops a single catastrophic category from zeroing the whole score,
	// which would make the number useless for tracking improvement.
	Floor float64 `yaml:"floor" json:"floor"`
}

// Config is the whole of cq.yaml.
type Config struct {
	Version int `yaml:"version" json:"version"`

	// Scopes map path globs onto the coarse areas incremental selection works
	// in. This is the repository telling the platform what its own layout means.
	Scopes map[string][]string `yaml:"scopes" json:"scopes"`

	// Analyzers holds per-analyzer overrides keyed by analyzer id: enable,
	// disable, retime, retimeout. The manifests stay pristine.
	Analyzers map[string]AnalyzerOverride `yaml:"analyzers" json:"analyzers,omitempty"`

	Budgets []Budget `yaml:"budgets" json:"budgets"`
	Scoring Scoring  `yaml:"scoring" json:"scoring"`

	// Paths the platform writes to, all repository-relative.
	ArtifactDir string `yaml:"artifactDir" json:"artifactDir"`
	CacheDir    string `yaml:"cacheDir" json:"cacheDir"`
	ReportDir   string `yaml:"reportDir" json:"reportDir"`

	// AnalyzerDirs are extra directories of analyzer manifests, layered over the
	// built-in catalog. This is how a team adds a check without forking.
	AnalyzerDirs []string `yaml:"analyzerDirs" json:"analyzerDirs,omitempty"`

	// Parallelism 0 means "one per CPU".
	Parallelism int `yaml:"parallelism" json:"parallelism"`

	// Ignore are globs no analyzer should ever see. Vendored code is not our
	// code, and reporting on it trains people to ignore the report.
	Ignore []string `yaml:"ignore" json:"ignore,omitempty"`

	// Report controls the shape of the AI-facing JSON.
	Report ReportOptions `yaml:"report" json:"report"`

	// Telemetry is optional and off by default.
	Telemetry Telemetry `yaml:"telemetry" json:"telemetry,omitempty"`

	// Path is where this config was loaded from.
	Path string `yaml:"-" json:"-"`
}

// AnalyzerOverride is a repository's per-analyzer adjustment.
type AnalyzerOverride struct {
	Enabled        *bool             `yaml:"enabled" json:"enabled,omitempty"`
	Tiers          []model.Tier      `yaml:"tiers" json:"tiers,omitempty"`
	TimeoutSeconds int               `yaml:"timeoutSeconds" json:"timeoutSeconds,omitempty"`
	Severity       model.Severity    `yaml:"severity" json:"severity,omitempty"`
	Env            map[string]string `yaml:"env" json:"env,omitempty"`
}

// ReportOptions are the token-economy dials. The defaults are chosen for an
// agent, not for a human reading a wall of JSON: an agent that is handed 4000
// findings will summarize them badly and fix none of them.
type ReportOptions struct {
	// MaxFindings caps the JSON report. Everything above the cap is counted in
	// the summary and left in the SARIF artifact, so nothing is lost, only
	// deferred.
	MaxFindings int `yaml:"maxFindings" json:"maxFindings"`
	// MaxPerAnalyzer stops one noisy analyzer crowding out every other signal.
	MaxPerAnalyzer int `yaml:"maxPerAnalyzer" json:"maxPerAnalyzer"`
	// MinSeverity drops findings below this level from the JSON report.
	MinSeverity model.Severity `yaml:"minSeverity" json:"minSeverity"`
	// NewOnly emits only findings absent from the baseline.
	NewOnly bool `yaml:"newOnly" json:"newOnly"`
	// EvidenceChars truncates each finding's evidence quotation.
	EvidenceChars int `yaml:"evidenceChars" json:"evidenceChars"`
}

// Telemetry configures the platform's observation of itself.
type Telemetry struct {
	Enabled bool `yaml:"enabled" json:"enabled"`
	// OTLPEndpoint is an OpenTelemetry collector's HTTP endpoint. Empty writes
	// the trace to a file next to the report instead, which is what a CI runner
	// with no collector should do.
	OTLPEndpoint string            `yaml:"otlpEndpoint" json:"otlpEndpoint,omitempty"`
	ServiceName  string            `yaml:"serviceName" json:"serviceName,omitempty"`
	Attributes   map[string]string `yaml:"attributes" json:"attributes,omitempty"`
}

// Load reads cq.yaml from the repository root, filling in defaults. A missing
// file is not an error: the platform is useful with zero configuration, and a
// team should be able to try it before it has an opinion.
func Load(root string) (*Config, error) {
	cfg := Default()
	for _, name := range []string{"cq.yaml", "cq.yml", ".cq.yaml"} {
		p := filepath.Join(root, name)
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		if err := yaml.Unmarshal(b, cfg); err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		cfg.Path = p
		break
	}
	applyDefaults(cfg)
	for _, b := range cfg.Budgets {
		if err := b.Validate(); err != nil {
			return nil, fmt.Errorf("%s: %w", cfg.displayPath(), err)
		}
	}
	return cfg, nil
}

func (c *Config) displayPath() string {
	if c.Path == "" {
		return "built-in defaults"
	}
	return c.Path
}

// BudgetByName finds a budget for `cq explain`.
func (c *Config) BudgetByName(name string) (Budget, bool) {
	for _, b := range c.Budgets {
		if b.Name == name {
			return b, true
		}
	}
	return Budget{}, false
}
