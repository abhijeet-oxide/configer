# Operations: scalability, security, observability, roadmap

## Scalability

### Where the time actually goes

On this repository, a cold `pr` run:

```
runtime-probe     heavy    browser launch dominates       ~60-120s
playwright        heavy    when a suite exists            ~60-300s
smoke             heavy    builds the backend, drives it  ~30-60s
go-test -race     moderate 2-10x the plain test time      ~30-90s
semgrep           moderate rule fetch dominates cold      ~30-120s
trivy             moderate database refresh dominates     ~10-60s
frontend-build    moderate                                 ~10-30s
typescript        moderate                                 ~5-20s
golangci-lint     moderate cold; seconds warm              ~10-60s
everything else   cheap                                    < 5s each
```

Wall clock is `max(critical path)`, not the sum, because the scheduler is
dependency-aware: an analyzer becomes runnable the instant its `needs` finish,
not when its "layer" does.

### The four levers, in the order to reach for them

**1. Incremental selection.** Already the default, and by far the largest
effect: a documentation change runs two analyzers instead of thirty.

**2. The cache.** A re-run after a small edit is dominated by cache hits.
See [incremental-execution.md](incremental-execution.md).

**3. Parallelism.** `--jobs`, defaulting to one per CPU. Heaviest-first ordering
means the long pole starts first and is never the last thing to begin.

**4. Tier placement.** Anything genuinely expensive belongs at `main` or
`nightly`. The catalog test enforces the sharp end of this: **no `heavy`
analyzer may appear in the `local` or `pre-commit` tiers**, because those tiers
have a seconds-level budget and a heavy check in them means the tier gets
disabled.

### When a single runner stops coping

The pipeline is deliberately one job today, because splitting means N cache
restores, N tool installations and N partial reports for the same wall clock.
Three thresholds change that:

| Symptom | Response |
|---|---|
| `pr` regularly over 10 minutes | Split by category across runners: a `frontend` job and a `backend` job, each running `cq run --only <ids>`, plus a merge job. `report.Sort()` makes the merge deterministic. |
| Coarse selection is the cost | Per-package selection: `go list -deps` for the backend, the Vite module graph for the frontend. `impact.Selector` is the seam. |
| The repository becomes a real monorepo | Bazel or Nx, with `cq` as an aspect rather than the orchestrator. See [ADR-0004](adr/0004-change-impact-selection.md). |

### Large repositories

- **Findings** are capped in the agent report, never in the SARIF. The cap is
  configuration.
- **Cache resolution** walks the tree once per analyzer and prunes at the
  directory level, so a `node_modules` tree costs a `SkipDir`, not a traversal.
- **The report is bounded**: at most 8 locations per finding, evidence truncated
  to a quotation, and no log ever inlined.
- **`Prune(maxAge)`** stops a long-lived CI cache growing until the restore
  itself becomes the slow step.

### Cost

The platform adds no infrastructure. No server, no database, no hosted service,
no per-seat licence: one static binary and whichever tools a runner already has.
The marginal cost of a run is CI minutes, and incremental selection plus caching
is what keeps that number small.

---

## Security model

### Least privilege

The GitHub workflow declares `permissions: contents: read` at the top level and
widens per job only to what is used: `security-events: write` for SARIF,
`pull-requests: write` for the comment and labels, `checks: write` for the
budget check run. The Azure pipeline uses `System.AccessToken` for the pull
request thread and nothing else.

`cq` itself needs no credentials. It reads the working tree, runs tools, writes
`.cq/`. No network access is required by the orchestrator: only some analyzers
need it, and each fails to an explained skip rather than to a hang.

### Pinned tool versions

Every analyzer version is pinned in the CI files, and the **tool version is part
of the cache key**, so an upgrade invalidates its own cached results rather than
serving stale ones. An unpinned scanner silently changes what "green" means
between two runs of the same commit, which is a reproducibility problem before
it is a security one.

### Verified downloads

Installs use each project's official action or its signed release archive over
HTTPS, never a `curl | sh` from an unpinned URL - with one exception, Syft's
official installer, which is itself checksummed and is only used on non-pull-request
runs.

### Reproducible builds

```
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X ...cli.Version=$(git describe)"
```

`-trimpath` removes build paths, `CGO_ENABLED=0` makes the binary static, and
the analyzer catalog is embedded so the binary and its plugins cannot drift.

### The platform's own supply chain

One module dependency: `gopkg.in/yaml.v3`, already in the repository. The tool
that reports supply-chain risk should not be a large part of it. This is a
substantial part of why [ADR-0009](adr/0009-otel-without-sdk.md) declines the
OpenTelemetry SDK.

### Secrets

- `gitleaks` is `alwaysRun`, severity `blocker`, and runs at the `pre-commit`
  tier: a credential can be pasted into a Markdown file just as easily as into a
  Go file, so this analyzer ignores the diff entirely.
- The recommendation is **"revoke it first"**, not "remove it from the file". A
  secret that was pushed is a secret that leaked, whatever the diff says now.
- Trivy runs with `--redact`-equivalent behaviour and the report never inlines a
  matched value; evidence for a secret finding is the rule, not the string.

### Signed artifacts

Not yet implemented. The roadmap item is `cosign sign-blob` over `report.json`
plus the SBOM, so a downstream consumer can verify the report was produced by
this pipeline. The SBOM (CycloneDX, from Syft) is already generated on `main`.

---

## Observability

The platform instruments itself, because one that cannot answer "why did this
take four minutes" has no standing to ask that of anybody else's code.

**In the report**, on every run:

- total duration, and per-analyzer duration
- cache hits and misses
- which analyzers ran, which were cached, which were skipped and why
- parallelism, platform, CI system
- score and verdict, for the trend

**As OpenTelemetry**, following the CI/CD semantic conventions:

```
SERVER   run pr                        cicd.pipeline.name, .run.id, .task.run.type
                                       cq.findings, cq.score, cq.verdict,
                                       cq.analyzers.selected/.skipped, cq.cache.hits
  INTERNAL analyze golangci-lint       cicd.pipeline.task.name, cq.analyzer.category,
                                       cq.analyzer.cost, cq.tool.version, cq.cache.hit
  INTERNAL analyze eslint              ...
```

Written to `.cq/artifacts/trace.otlp.json` always, and POSTed to
`telemetry.otlpEndpoint` when one is configured. Telemetry is **advisory
everywhere**: a collector that is down may never turn a passing quality run into
a failing one, and the CLI says so rather than failing.

**Metrics worth alerting on**, once there is a collector:

| | |
|---|---|
| p95 run duration by tier | the feedback loop degrading |
| cache hit rate | below ~60% on `pr` means the cache keys are wrong |
| analyzer failure rate by id | a flaky or broken tool |
| skip rate by reason | `missing-tool` climbing means a runner drifted |
| budget failure rate by name | a gate that always fails is a gate nobody reads |

That last one is Google's Tricorder lesson turned into a metric: an analyzer
whose findings are always dismissed should be disabled, and the way to know is
to measure it.

---

## Roadmap

### Next

- **Frontend unit tests and coverage.** Vitest with LCOV output; the `lcov`
  normalizer and the coverage budgets already exist, so it is one manifest.
- **A Playwright suite**, which switches on both the e2e and the visual
  regression analyzers already in the catalog.
- **`cq fix --safe`.** Apply every finding where `fix.safeToAutomate` is true,
  by delegating to each tool's own fixer (`eslint --fix`, `gofmt -w`,
  `make docs`). The data is already in the report; this is the command that
  closes the agent loop without an agent.
- **Schemathesis** at the `main` tier: property-based testing of the running API
  against its OpenAPI spec.
- **`jsx-a11y`** in the ESLint config, for the accessibility findings that are
  statically visible.

### Then

- **Actual re-render counting.** The genuine gap in
  [ADR-0008](adr/0008-runtime-probe.md): static rules find *risk*, not
  *occurrence*. A React Profiler hook in the runtime probe could report "this
  component rendered 40 times on one interaction", which is the finding people
  actually want.
- **A metric store.** Baselines are per-ref snapshots today, which is enough for
  regression gating and not enough for a trend line. A small time series behind
  the report unlocks statistical process control on noisy metrics, which is
  strictly better than the fixed percentages the budgets guess at now.
- **A shared remote cache.** `Cache` is shaped for it: an S3 or Redis backing
  would let a developer's machine benefit from CI's work and vice versa.
- **Signed reports.** `cosign sign-blob` over `report.json` and the SBOM.
- **StrykerJS** for frontend mutation testing, at the `nightly` tier.
- **Continuous profiling** (Parca or Pyroscope) in the deployed service. A
  production concern rather than a merge gate, but the place where CPU and
  memory regressions actually show up.

### Deliberately not doing

- **A hosted dashboard.** The HTML report is self-contained and the JSON is
  open; a dashboard is a service to run, and the data is already in a shape any
  existing dashboard can read.
- **A custom linter, profiler, scanner or coverage tool.** ADR-0001.
- **Gating on the score.** It exists for the trend line. Gates are budgets:
  named, explained, and configurable.
