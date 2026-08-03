# Architecture

## Component diagram

```
                                repository
                                     |
   +---------------------------------+---------------------------------+
   |                                 |                                 |
   v                                 v                                 v
cq.yaml                    analyzer manifests                     git history
(budgets, scopes,          (33 embedded + any                     (merge base,
 caps, overrides)           analyzerDirs)                          diff, staged)
   |                                 |                                 |
   v                                 v                                 v
+------------+              +-------------+                    +-------------+
|   spec     |              |   catalog   |                    |   impact    |
| load and   |              | load,       |                    | diff, scope |
| default    |              | validate,   |                    | classify,   |
|            |              | override    |                    | select      |
+-----+------+              +------+------+                    +------+------+
      |                            |                                  |
      +----------------------------+----------------------------------+
                                   |
                                   v
                        +---------------------+
                        |       engine        |   the only thing that
                        |    orchestration    |   knows the order
                        +----+-----------+----+
                             |           |
             +---------------+           +---------------+
             v                                           v
      +-------------+                            +--------------+
      |    cache    |  hit? use it               |   runner     |
      | content-    |<---------------------------| probe, exec, |
      | addressed   |  miss? store it            | timeout, log |
      +-------------+                            +------+-------+
                                                        | raw bytes
                                                        v
                                                 +--------------+
                                                 |  normalize   |
                                                 | sarif junit  |
                                                 | lcov cdx ... |
                                                 +------+-------+
                                                        | Finding[], Metric[]
      +-------------+   +---------+   +---------+       |
      |   dedupe    |<--|  merge  |<--| collect |<------+
      +------+------+   +---------+   +---------+
             |
             v
      +-------------+      +-------------+      +-------------+
      |  baseline   |----->|   policy    |----->|    score    |
      | new/fixed   |      |  budgets    |      | per category|
      +-------------+      +-------------+      +------+------+
                                                       |
                                                       v
                                              +-----------------+
                                              |     report      |
                                              | json  agent-json|
                                              | md    sarif     |
                                              | junit html      |
                                              +--------+--------+
                                                       |
                          +----------------------------+---------------+
                          v                            v               v
                     exit code                  telemetry (OTLP)   artifacts
                  0 / 1 / 2                     spans per analyzer  logs, raw
```

Package boundaries are enforced by direction: `model` depends on nothing,
`normalize` depends on `model`, `engine` depends on everything, and nothing
depends on `engine`. There is no cycle and no shared mutable state between
analyzers.

## Execution flow

```
1  load     cq.yaml (or the built-in defaults), then the analyzer catalog
            embedded manifests, then any analyzerDirs, then per-analyzer overrides
            validate: category, tiers, command, output format, needs, cycles

2  plan     git merge-base <base> HEAD, then diff --name-status
            plus the working tree (or the index, with --staged)
            classify changed paths into scopes
            select analyzers by tier x (scope | path | alwaysRun | --only)
            pull in prerequisites transitively
            order heaviest first
            -> every non-selected analyzer carries a sentence saying why

3  execute  for each selected analyzer, up to `parallelism` at once:
              probe the tool          -> absent? explained skip, never a failure
              compute the cache key   -> hit? reuse the normalized result
              run it with a timeout   -> capture stdout, stderr, artifact file
              normalize the output    -> Finding[] + Metric[]
              store in the cache
            an analyzer becomes runnable the instant its `needs` are done,
            not when its "layer" is done
            a failed prerequisite blocks its dependents with a reason

4  merge    dedupe: exact fingerprint, then same-location same-meaning
            worst severity wins, best confidence wins, corroboration recorded
            safeToAutomate is a floor, not an average

5  judge    load the baseline for the base ref
            mark new findings, count fixed ones
            evaluate every budget: absolute and regression
            score per category, then overall (weighted)
            write the headline and the next steps

6  emit     report.json          the archive and the dashboard input
            report-agent.json    the agent contract, capped and trimmed
            report.md            the pull request comment
            report.sarif         the code scanning tab
            report.junit.xml     the CI test panel, one case per budget
            report.html          the self-contained dashboard
            trace.otlp.json      the platform's own spans

7  exit     0 clean | 1 a blocking budget failed | 2 the platform broke
```

## The plugin contract

Adding a check is one file. This is the whole interface:

```yaml
id: my-check                    # slug, unique
name: My check                  # what a person calls it
description: What a failure means, in one sentence.
category: backend               # frontend|backend|api|security|infrastructure|tests|general
tags: [performance]             # carried onto findings, used by PR labelling

tiers: [pr, main]               # which stages this belongs to
scopes: [backend]               # run when these areas changed
paths: ["backend/**/*.go"]      # ...or when a changed file matches
alwaysRun: false                # ...or unconditionally
cost: moderate                  # cheap|moderate|heavy - scheduling order and default timeout
needs: [some-other-check]       # must succeed first

tool:
  command: mytool
  args: ["--json", "--out", "{out}"]
  probe: ["mytool", "--version"] # decides availability; cheap and side-effect free
  versionArgs: ["--version"]     # goes into the cache key
  workdir: backend
  env: {FOO: "bar"}
  okExitCodes: [1]               # non-zero that means "ran fine, found things"
  optional: true                 # absence is normal, not a problem
  install: "How to get it."      # printed when it is missing - never a variable name

output:
  format: sarif                  # a registered normalizer
  file: "mytool.sarif"           # relative to the artifact dir; omit to read stdout
  kind: sarif                    # artifact label

defaults:                        # applied to every finding this tool produces
  severity: warning
  confidence: high
  safeToAutomate: false
  effort: small
  docsUrl: https://...

cache:
  inputs: ["backend/**/*.go"]    # no inputs means no caching, which is the safe default
```

Templating available in `args`, `env` and `output.file`: `{repo}`, `{workdir}`,
`{artifacts}`, `{reports}`, `{out}`, `{base_ref}`, `{tier}`, `{changed_files}`.
Child processes also get `CQ_REPO`, `CQ_ARTIFACTS`, `CQ_REPORTS`, `CQ_TIER`,
`CQ_BASE_REF` and `CQ_ANALYZER`.

`changedFilesArg` appends the diff to the command (one argument per file, or
prefixed by a flag), with `maxChangedFiles` falling back to a whole-tree run when
per-file invocation stops being cheaper.

Drop the file in `quality/internal/catalog/manifests/` to ship it, or in a
directory named by `analyzerDirs` in `cq.yaml` to keep it local. No Go code, no
registration, no rebuild of the orchestrator.

## The normalizer contract

A format, not a tool, earns Go code:

```go
func init() { Register("myformat", normalizeMyFormat) }

func normalizeMyFormat(in Input) (Result, error) {
    // in.Data     the artifact bytes, or stdout
    // in.Analyzer the manifest, for its defaults
    // in.ExitCode, in.Stderr, in.Root
    return Result{Findings: ..., Metrics: ...}, nil
}
```

19 normalizers cover 33 analyzers:

| Normalizer | Carries |
|---|---|
| `sarif` | golangci-lint, Semgrep, Trivy, Gitleaks, OSV-Scanner, govulncheck, Hadolint, KubeLinter |
| `exit-code` | tsc, go vet, gofmt, vite build, make docs-check, smoke, no-emdash |
| `junit` | Playwright, and any other test runner |
| `cq` (native) | the runtime probe, and anything routed through `scripts/cq/adapt.mjs` |
| `eslint`, `knip`, `jscpd`, `dependency-cruiser` | one each, native JSON |
| `go-test-json`, `go-cover`, `lcov`, `cobertura` | tests and coverage |
| `lighthouse`, `k6-summary`, `benchstat-csv`, `size-limit` | performance |
| `cyclonedx` | SBOM, vulnerabilities and licences |
| `oasdiff`, `spectral` | API contract |

## How a finding travels

```
golangci-lint writes SARIF
        |
        |  normalize/sarif.go
        |    level+security-severity -> Severity
        |    rule precision           -> Confidence
        |    manifest defaults        -> Fix.SafeToAutomate, Effort, DocsURL
        |    partialFingerprints      -> stable identity across line moves
        v
   model.Finding
        |
        |  dedupe: Semgrep reported the same line
        |    worst severity, best confidence, both tool names recorded
        |    two independent tools agreeing -> confidence becomes high
        v
   model.Finding {tools: [golangci-lint, semgrep], confidence: high}
        |
        |  baseline: absent from the base branch's record
        v
   model.Finding {new: true}
        |
        +--> policy   counted by `no-new-blocking-findings`, which fails
        +--> score    8 points off the backend category
        +--> markdown "### New in this change"
        +--> sarif    back out, merged, into the code scanning tab
        +--> agent    with its recommendation and safeToAutomate flag
```

## Concurrency

One process, one goroutine per running analyzer, bounded by `parallelism`
(default: one per CPU). The scheduler is dependency-aware rather than
wave-based, which matters: an analyzer becomes runnable the instant its
prerequisites finish, so a two-minute browser run never waits for a four-second
linter that happens to be in the same "layer".

Heaviest-first ordering means the long pole starts first and never ends up being
the last thing to begin.

No shared mutable state: each analyzer writes to its own artifact path, and
results are collected under a mutex into a per-analyzer map. Cancellation
propagates through `context`, so an interrupted run kills its children rather
than orphaning them on a runner.
