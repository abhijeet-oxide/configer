package model

import (
	"fmt"
	"strings"
)

// Cost is a coarse scheduling hint. The scheduler starts expensive analyzers
// first so the long pole is never the last thing to begin.
type Cost string

const (
	CostCheap    Cost = "cheap"    // < 5s
	CostModerate Cost = "moderate" // seconds to a minute
	CostHeavy    Cost = "heavy"    // minutes; browsers, load tests, mutation runs
)

// Weight orders costs for scheduling; higher goes first.
func (c Cost) Weight() int {
	switch c {
	case CostHeavy:
		return 2
	case CostModerate:
		return 1
	default:
		return 0
	}
}

// Tool is how an analyzer is invoked and how the platform decides whether it can
// be invoked at all. Every field here exists so that a missing tool is a clean,
// explained skip rather than a red pipeline: an analyzer the deployment cannot
// run must never look like code that failed.
type Tool struct {
	// Command and Args are the invocation. Args are templated (see Render).
	Command string   `yaml:"command" json:"command"`
	Args    []string `yaml:"args" json:"args"`
	// Probe decides availability. It must be cheap and side-effect free.
	Probe []string `yaml:"probe" json:"probe,omitempty"`
	// VersionArgs prints the tool version; it goes into the cache key so an
	// upgraded linter invalidates its own cached results.
	VersionArgs []string `yaml:"versionArgs" json:"versionArgs,omitempty"`
	// Pin is the version this repository expects. It is recorded in the report
	// and, where the runner can, enforced: reproducible builds start here.
	Pin string `yaml:"pin" json:"pin,omitempty"`
	// Install is the human sentence printed when the tool is missing. Never an
	// environment variable, always an action.
	Install string `yaml:"install" json:"install,omitempty"`
	// Workdir is relative to the repository root.
	Workdir string `yaml:"workdir" json:"workdir,omitempty"`
	// Env are extra environment variables for the child process.
	Env map[string]string `yaml:"env" json:"env,omitempty"`
	// OkExitCodes are exit codes that mean "ran fine, may have found things".
	// Most linters exit non-zero when they report; that is not a crash.
	OkExitCodes []int `yaml:"okExitCodes" json:"okExitCodes,omitempty"`
	// Optional marks an analyzer whose absence is normal (a browser on a
	// developer's laptop, a load generator in a container-less runner).
	Optional bool `yaml:"optional" json:"optional,omitempty"`
}

// Output tells the normalizer what shape to expect and where to find it.
type Output struct {
	// Format names a registered normalizer, e.g. sarif, junit, lcov, lighthouse.
	Format string `yaml:"format" json:"format"`
	// File is where the tool writes its machine-readable output. Templated.
	// Empty means the normalizer reads the process's stdout.
	File string `yaml:"file" json:"file,omitempty"`
	// Kind labels the artifact in the report's artifact list.
	Kind string `yaml:"kind" json:"kind,omitempty"`
}

// Defaults are the analyzer-level judgements the platform applies to every
// finding the tool produces. Confidence and SafeToAutomate belong here rather
// than on the finding because they are a property of the CHECK, not of the
// instance: "eslint's no-unused-vars is always right and always safe to fix"
// is a statement about the rule, and it is reviewed once, in the manifest.
type Defaults struct {
	Severity       Severity   `yaml:"severity" json:"severity,omitempty"`
	Confidence     Confidence `yaml:"confidence" json:"confidence,omitempty"`
	SafeToAutomate bool       `yaml:"safeToAutomate" json:"safeToAutomate,omitempty"`
	Effort         string     `yaml:"effort" json:"effort,omitempty"`
	DocsURL        string     `yaml:"docsUrl" json:"docsUrl,omitempty"`
	Recommendation string     `yaml:"recommendation" json:"recommendation,omitempty"`
}

// CacheSpec declares what the analyzer's answer depends on. Everything listed
// is hashed; if the hash is unchanged the previous result is reused verbatim.
// An analyzer with no Inputs is never cached, which is the safe default.
type CacheSpec struct {
	Inputs []string `yaml:"inputs" json:"inputs,omitempty"`
	// Disabled turns caching off for an analyzer whose result depends on
	// something the platform cannot hash (wall-clock, a network service).
	Disabled bool `yaml:"disabled" json:"disabled,omitempty"`
}

// Analyzer is the whole plugin contract. Adding a check to the platform is
// writing one of these as a YAML file and nothing else: no Go code, no
// registration call, no rebuild of the orchestrator.
type Analyzer struct {
	ID          string   `yaml:"id" json:"id"`
	Name        string   `yaml:"name" json:"name"`
	Description string   `yaml:"description" json:"description,omitempty"`
	Category    Category `yaml:"category" json:"category"`
	Tags        []string `yaml:"tags" json:"tags,omitempty"`

	// Tiers are the stages this analyzer belongs to. A run at tier T executes
	// every analyzer whose Tiers contain T.
	Tiers []Tier `yaml:"tiers" json:"tiers"`
	// Scopes gate the analyzer on what actually changed. Empty means always.
	Scopes []string `yaml:"scopes" json:"scopes,omitempty"`
	// Paths are globs; when set, the analyzer runs only if a changed file
	// matches one. This is the second, finer half of incremental selection.
	Paths []string `yaml:"paths" json:"paths,omitempty"`
	// AlwaysRun opts out of incremental selection entirely (a repository-wide
	// SBOM has no meaningful diff scope).
	AlwaysRun bool `yaml:"alwaysRun" json:"alwaysRun,omitempty"`

	// ChangedFilesArg, when set, is appended once per changed file so a linter
	// can lint only the diff. Without it the analyzer sees the whole tree.
	ChangedFilesArg string `yaml:"changedFilesArg" json:"changedFilesArg,omitempty"`
	// MaxChangedFiles falls back to a whole-tree run when the diff is so large
	// that per-file invocation stops being the cheaper option.
	MaxChangedFiles int `yaml:"maxChangedFiles" json:"maxChangedFiles,omitempty"`

	Tool     Tool      `yaml:"tool" json:"tool"`
	Output   Output    `yaml:"output" json:"output"`
	Defaults Defaults  `yaml:"defaults" json:"defaults,omitempty"`
	Cache    CacheSpec `yaml:"cache" json:"cache,omitempty"`

	// Needs are analyzer IDs that must succeed first (a build before a bundle
	// measurement, a server before a load test).
	Needs []string `yaml:"needs" json:"needs,omitempty"`

	TimeoutSeconds int  `yaml:"timeoutSeconds" json:"timeoutSeconds,omitempty"`
	Cost           Cost `yaml:"cost" json:"cost,omitempty"`
	// Enabled defaults to true; a repository disables an analyzer by name in
	// cq.yaml rather than by deleting the manifest.
	Enabled *bool `yaml:"enabled" json:"enabled,omitempty"`

	// Source is where this manifest was loaded from, for `cq doctor`.
	Source string `yaml:"-" json:"source,omitempty"`
}

// IsEnabled reports the effective enabled state.
func (a Analyzer) IsEnabled() bool { return a.Enabled == nil || *a.Enabled }

// Timeout returns the analyzer's timeout, defaulted by cost.
func (a Analyzer) Timeout() int {
	if a.TimeoutSeconds > 0 {
		return a.TimeoutSeconds
	}
	switch a.Cost {
	case CostHeavy:
		return 900
	case CostModerate:
		return 300
	default:
		return 60
	}
}

// RunsAt reports whether the analyzer belongs to the given tier.
func (a Analyzer) RunsAt(t Tier) bool {
	for _, x := range a.Tiers {
		if x == t {
			return true
		}
	}
	return false
}

// Validate catches the manifest mistakes that would otherwise show up as a
// confusing runtime failure. It runs at load time for every manifest, so a
// malformed plugin is reported by `cq doctor` and never by a broken pipeline.
func (a Analyzer) Validate() error {
	if a.ID == "" {
		return fmt.Errorf("analyzer has no id")
	}
	if strings.ContainsAny(a.ID, " /\\") {
		return fmt.Errorf("analyzer %q: id must be a slug (no spaces or slashes)", a.ID)
	}
	if a.Category == "" {
		return fmt.Errorf("analyzer %q: category is required", a.ID)
	}
	known := false
	for _, c := range AllCategories {
		if c == a.Category {
			known = true
		}
	}
	if !known {
		return fmt.Errorf("analyzer %q: unknown category %q", a.ID, a.Category)
	}
	if len(a.Tiers) == 0 {
		return fmt.Errorf("analyzer %q: at least one tier is required", a.ID)
	}
	for _, t := range a.Tiers {
		if tierRank(t) < 0 {
			return fmt.Errorf("analyzer %q: unknown tier %q", a.ID, t)
		}
	}
	if a.Tool.Command == "" {
		return fmt.Errorf("analyzer %q: tool.command is required", a.ID)
	}
	if a.Output.Format == "" {
		return fmt.Errorf("analyzer %q: output.format is required", a.ID)
	}
	return nil
}
