package spec

import "github.com/abhijeet-oxide/configer/quality/internal/model"

func f(v float64) *float64 { return &v }
func b(v bool) *bool       { return &v }

// Default is the configuration a repository gets with no cq.yaml at all. It is
// deliberately opinionated but not punitive: every absolute budget that a real
// codebase can plausibly fail on day one ships non-blocking, and the blocking
// ones are the regression gates, which any repository can pass by not making
// things worse.
func Default() *Config {
	return &Config{
		Version: 1,
		Scopes: map[string][]string{
			"frontend": {"frontend/**"},
			"backend":  {"backend/**"},
			"api": {
				"backend/internal/api/**",
				"backend/internal/api/docs/**",
				"frontend/src/api.ts",
			},
			"infra": {
				"deploy/**", "**/Dockerfile", "**/*.dockerfile",
				"**/kustomization.yaml", "**/Chart.yaml", "**/values.yaml",
				"sample-repo/**", "sample-repos/**",
			},
			"ci":   {".github/**", ".azure/**", "scripts/**", "Makefile", "quality/**"},
			"deps": {"**/go.mod", "**/go.sum", "**/package.json", "**/package-lock.json"},
			"docs": {"**/*.md", "docs/**", "**/*.txt"},
		},
		ArtifactDir: ".cq/artifacts",
		CacheDir:    ".cq/cache",
		ReportDir:   ".cq",
		Parallelism: 0,
		Ignore: []string{
			"**/node_modules/**", "**/dist/**", "**/vendor/**",
			"**/.git/**", "**/bin/**", "**/testdata/**", ".cq/**",
			"graphify-out/**",
		},
		Report: ReportOptions{
			MaxFindings:    120,
			MaxPerAnalyzer: 25,
			MinSeverity:    model.SeverityNote,
			EvidenceChars:  200,
		},
		Scoring: Scoring{
			Penalty: map[string]float64{
				"blocker": 25, "error": 8, "warning": 2, "note": 0.5, "info": 0,
			},
			BudgetFailPenalty: 15,
			CategoryWeights: map[string]float64{
				"security": 2, "backend": 1.5, "frontend": 1.5, "api": 1.25,
			},
			Floor: 0,
		},
		Telemetry: Telemetry{ServiceName: "configer-cqp"},
		Budgets:   defaultBudgets(),
	}
}

// defaultBudgets is the shipped policy. Read it as the platform's answer to
// "what does good look like here"; a repository overrides any line of it.
func defaultBudgets() []Budget {
	return []Budget{
		// ---- absolute, blocking: the things that are never acceptable -------
		{
			Name:        "no-critical-security",
			Description: "No error-or-worse security finding may reach the default branch.",
			Findings:    &FindingSelector{Category: model.CategorySecurity, MinSeverity: model.SeverityError},
			Max:         f(0),
			Category:    model.CategorySecurity,
		},
		{
			Name:        "no-secrets",
			Description: "A committed credential fails the build outright.",
			Findings:    &FindingSelector{Tag: "secret"},
			Max:         f(0),
			Category:    model.CategorySecurity,
		},
		{
			Name:        "no-console-errors",
			Description: "The application must reach its main screens without a console error or uncaught exception.",
			Metric:      "frontend.console.errors",
			Max:         f(0),
			Category:    model.CategoryFrontend,
		},
		{
			Name:        "no-race-conditions",
			Description: "The Go race detector must be clean.",
			Metric:      "backend.races",
			Max:         f(0),
			Category:    model.CategoryBackend,
		},
		{
			Name:        "no-goroutine-leaks",
			Description: "Every goroutine started by a test must have exited when it ends.",
			Metric:      "backend.goroutine_leaks",
			Max:         f(0),
			Category:    model.CategoryBackend,
		},
		{
			Name:        "no-new-blocking-findings",
			Description: "A change may not introduce a new error-level finding of any kind.",
			Findings:    &FindingSelector{MinSeverity: model.SeverityError, OnlyNew: true},
			Max:         f(0),
			Tiers:       []model.Tier{model.TierPR, model.TierMain},
		},
		{
			Name:        "no-breaking-api-changes",
			Description: "The published OpenAPI contract may not break an existing client.",
			Metric:      "api.breaking_changes",
			Max:         f(0),
			Category:    model.CategoryAPI,
		},

		// ---- regression-based: the everyday gates --------------------------
		{
			Name:           "bundle-growth",
			Description:    "The gzipped frontend bundle may not grow by more than 5% against the base branch.",
			Metric:         "frontend.bundle.total_gzip",
			MaxIncreasePct: f(5),
			WarnAt:         f(2),
			Category:       model.CategoryFrontend,
		},
		{
			Name:           "api-call-growth",
			Description:    "A screen may not start making materially more network requests than it did.",
			Metric:         "frontend.network.requests",
			MaxIncreasePct: f(25),
			Category:       model.CategoryAPI,
		},
		{
			Name:           "backend-latency-regression",
			Description:    "p95 request latency may not regress by more than 10%.",
			Metric:         "backend.latency.p95",
			MaxIncreasePct: f(10),
			Category:       model.CategoryBackend,
		},
		{
			Name:           "benchmark-regression",
			Description:    "No Go benchmark may get more than 15% slower.",
			Metric:         "backend.bench.ns_per_op|*",
			MaxIncreasePct: f(15),
			Category:       model.CategoryBackend,
		},
		{
			Name:           "allocation-regression",
			Description:    "No Go benchmark may allocate more than 20% more per operation.",
			Metric:         "backend.bench.bytes_per_op|*",
			MaxIncreasePct: f(20),
			Blocking:       b(false),
			Category:       model.CategoryBackend,
		},
		{
			Name:        "coverage-floor",
			Description: "Line coverage may not fall below the level of the base branch.",
			Metric:      "general.coverage.lines",
			MaxDecrease: f(0.5),
			Category:    model.CategoryTests,
		},

		// ---- absolute, non-blocking: aspirations, measured before enforced --
		{
			Name:        "accessibility-clean",
			Description: "Zero axe-core violations on the audited routes.",
			Metric:      "frontend.a11y.violations",
			Max:         f(0),
			Blocking:    b(false),
			Category:    model.CategoryFrontend,
		},
		{
			Name:        "lighthouse-performance",
			Description: "Lighthouse performance stays at 90 or above; below 85 fails.",
			Metric:      "frontend.lighthouse.performance|*",
			Min:         f(85),
			WarnAt:      f(90),
			Blocking:    b(false),
			Category:    model.CategoryFrontend,
		},
		{
			Name:        "coverage-target",
			Description: "Line coverage target of 85%.",
			Metric:      "general.coverage.lines",
			Min:         f(85),
			Blocking:    b(false),
			Category:    model.CategoryTests,
		},
		{
			Name:        "duplication-ceiling",
			Description: "Duplicated code stays under 5% of the codebase.",
			Metric:      "general.duplication.percent",
			Max:         f(5),
			Blocking:    b(false),
			Category:    model.CategoryGeneral,
		},
		{
			Name:        "no-circular-dependencies",
			Description: "The frontend module graph stays acyclic.",
			Metric:      "frontend.circular_dependencies",
			Max:         f(0),
			Blocking:    b(false),
			Category:    model.CategoryFrontend,
		},
		{
			Name:        "dead-code-ceiling",
			Description: "Unused exports and files stay in single digits.",
			Metric:      "general.dead_code.items",
			Max:         f(10),
			Blocking:    b(false),
			Category:    model.CategoryGeneral,
		},
		{
			Name:        "no-flaky-tests",
			Description: "No test may be quarantined as flaky without an owner.",
			Metric:      "tests.flaky",
			Max:         f(0),
			Blocking:    b(false),
			Category:    model.CategoryTests,
		},
	}
}

// applyDefaults fills the holes a partial cq.yaml leaves. A repository that
// sets only `budgets:` must still get sane paths, scoring and report caps.
func applyDefaults(c *Config) {
	d := Default()
	if c.Version == 0 {
		c.Version = d.Version
	}
	if len(c.Scopes) == 0 {
		c.Scopes = d.Scopes
	}
	if c.ArtifactDir == "" {
		c.ArtifactDir = d.ArtifactDir
	}
	if c.CacheDir == "" {
		c.CacheDir = d.CacheDir
	}
	if c.ReportDir == "" {
		c.ReportDir = d.ReportDir
	}
	if len(c.Ignore) == 0 {
		c.Ignore = d.Ignore
	}
	if len(c.Budgets) == 0 {
		c.Budgets = d.Budgets
	}
	if c.Report.MaxFindings == 0 {
		c.Report.MaxFindings = d.Report.MaxFindings
	}
	if c.Report.MaxPerAnalyzer == 0 {
		c.Report.MaxPerAnalyzer = d.Report.MaxPerAnalyzer
	}
	if c.Report.MinSeverity == "" {
		c.Report.MinSeverity = d.Report.MinSeverity
	}
	if c.Report.EvidenceChars == 0 {
		c.Report.EvidenceChars = d.Report.EvidenceChars
	}
	if len(c.Scoring.Penalty) == 0 {
		c.Scoring.Penalty = d.Scoring.Penalty
	}
	if c.Scoring.BudgetFailPenalty == 0 {
		c.Scoring.BudgetFailPenalty = d.Scoring.BudgetFailPenalty
	}
	if len(c.Scoring.CategoryWeights) == 0 {
		c.Scoring.CategoryWeights = d.Scoring.CategoryWeights
	}
	if c.Telemetry.ServiceName == "" {
		c.Telemetry.ServiceName = d.Telemetry.ServiceName
	}
}
