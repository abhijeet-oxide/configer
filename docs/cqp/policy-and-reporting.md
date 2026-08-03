# Quality gates, the report, and how an agent uses it

## The policy engine

A budget is either a **measurement** budget or a **finding** budget, and either
one can be absolute, regression-based, or both.

```yaml
budgets:
  # regression, blocking - the everyday gate
  - name: bundle-growth
    description: The gzipped bundle may not grow more than 5% against the base branch.
    metric: frontend.bundle.total_gzip
    maxIncreasePct: 5
    warnAt: 2

  # absolute zero, blocking - where zero is the only acceptable number
  - name: no-console-errors
    metric: frontend.console.errors
    max: 0

  # findings, only what this change added
  - name: no-new-blocking-findings
    findings: { minSeverity: error, onlyNew: true }
    max: 0
    tiers: [pr, main]

  # aspirational: measured and reported, never blocking
  - name: coverage-target
    metric: general.coverage.lines
    min: 85
    blocking: false

  # one budget, every subject
  - name: benchmark-regression
    metric: backend.bench.ns_per_op|*
    maxIncreasePct: 15
```

### Four statuses, and the two that matter

| Status | Meaning |
|---|---|
| `pass` | Within the rule. |
| `warn` | Past `warnAt`, inside the hard limit. Reported, never blocking. |
| `fail` | Outside the rule. Blocks if `blocking` (the default). |
| `skip` | **Not evaluated**, and the report says why. |

`skip` is the load-bearing one. A budget is skipped when:

- nothing in this run produced its metric (a documentation change does not
  measure the bundle, and claiming it did not regress would be a lie), or
- it is a regression budget and **there is no baseline to compare against**.

Reporting `pass` in the second case would silently disable every regression
budget on every new branch - which is exactly when people trust the gate most.
This is asserted by a test, because it is the kind of thing that gets
"simplified" later.

### The failure message is the product

```
bundle-growth  FAIL
Total bundle size (gzip) grew 9.1% against origin/main
(now 1.14 MB, was 1.05 MB), and the budget allows 5.0%
```

Measurement, baseline, delta, rule, and the ref compared against - in one
sentence, without git jargon and without opening a log. The policy tests assert
the exact substrings, because a failure a reader has to decode is a failure they
will route around.

For a finding budget the message names the offenders:

```
no-critical-security  FAIL
1 error-or-worse security findings, and the budget allows 0.
First: CVE-2025-0001 in golang.org/x/net (backend/go.mod).
```

### Selectors

```yaml
findings:
  category: security         # frontend|backend|api|security|infrastructure|tests|general
  minSeverity: error         # blocker|error|warning|note|info
  analyzer: gitleaks         # a specific tool
  tag: secret                # an analyzer-declared tag
  onlyNew: true              # absent from the baseline
```

`onlyNew` is what makes a strict budget adoptable on a repository with existing
debt: hold the line at zero without demanding the backlog be cleared first.

### Wildcards

`metric: backend.bench.ns_per_op|*` produces one result per subject - one per
benchmark, one per Lighthouse route, one per bundle asset. The alternative is a
budget per subject, which nobody maintains.

### Scoring

Per category: start at 100, subtract a penalty per finding by severity
(blocker 25, error 8, warning 2, note 0.5), scaled down for lower confidence
(medium x0.7, low x0.3), plus 15 per failed blocking budget in that category.
Overall is the weighted mean (security x2, backend and frontend x1.5, api x1.25).

**No merge decision is ever made on the score.** It exists for the trend line
and for the one-glance question "did this change make things better or worse".
Gates are budgets, which are named, explained and configurable - so a wrong
weight here can never block anybody.

---

## The report

Six artifacts, one source of truth.

| File | For | Contents |
|---|---|---|
| `report.json` | archive, dashboards, `cq explain` | everything |
| `report-agent.json` | **AI agents** | capped, trimmed, declared |
| `report.md` | the pull request comment | verdict, budgets, new findings, next steps |
| `report.sarif` | GitHub code scanning, Azure SARIF viewer | merged findings, one run |
| `report.junit.xml` | the CI test panel | one test case per budget |
| `report.html` | a person | self-contained, no network, light and dark |

Plus `.cq/artifacts/`: every tool's raw output, every analyzer's log, and
`trace.otlp.json`.

The full schema is [`quality/schema/report.schema.json`](../../quality/schema/report.schema.json).
The shape:

```jsonc
{
  "schema": "1.0.0",
  "run":     { "id", "commit", "branch", "baseRef", "ci", "cacheHits", ... },
  "summary": { "verdict", "score", "scoreDelta", "trend", "headline",
               "counts", "newFindings", "fixedSinceBaseline",
               "blockedBy", "nextSteps" },
  "selection": { "tier", "changedFiles", "scopes", "selected", "skipped", "reason" },
  "budgets":   [ { "budget", "status", "value", "baseline", "deltaPct",
                   "limit", "message", "blocking" } ],
  "categories":[ { "category", "score", "verdict", "counts" } ],
  "findings":  [ { "id", "analyzer", "rule", "category", "severity", "confidence",
                   "title", "detail", "where", "evidence",
                   "fix": { "recommendation", "safeToAutomate", "effort", "docsUrl" },
                   "tools", "occurrences", "new", "tags" } ],
  "metrics":   [ { "id", "name", "value", "unit", "direction", "subject" } ],
  "analyzers": [ { "id", "status", "durationMs", "cacheHit", "artifact" } ],
  "artifacts": [ { "name", "path", "kind" } ],
  "platformErrors": [ ]
}
```

Two fields deserve calling out because everything else depends on them.

**`findings[].id`** is a fingerprint of rule + file + the message with numbers
normalized away. It deliberately **excludes the line number**: a finding that
moved because somebody added an import above it is the same finding, and a
fingerprint that changes on every reformat makes the baseline worthless.

**`fix.safeToAutomate`** is the platform's statement that applying this change
unattended is expected to be correct. It is set per-**analyzer**, in a reviewed
manifest, because "ESLint's `no-unused-vars` is always mechanical" is a fact
about the rule, not about the instance. Where a tool has its own signal - ESLint's
`fix` field - that wins. On a merged finding it is the **floor** of the merged
values: if either tool says it is not mechanical, it is not.

**`platformErrors`** is kept strictly apart from `findings`. A tool that crashed
must never look like a code defect, because an agent told "your code has an
error" will change the code. A run with platform errors cannot report `pass`; it
degrades to `warn` with the errors named.

---

## Token economy

`report-agent.json` is the same document, reduced:

| Reduction | Default | Why |
|---|---|---|
| severity floor | `note` | An `info` finding is not worth an agent's attention. |
| `newOnly` | off | A change is answerable for what it added; on for a fast PR loop. |
| total cap | 120 | An agent handed 4000 findings summarizes them badly and fixes none. |
| per-analyzer cap | 25 | One noisy linter cannot crowd out the security scanner. |
| evidence | 200 chars | A quotation, not a transcript. |
| detail | 240 chars | Same. |
| `analyzers[]` | dropped | Timing is operator data. |
| metrics | budget-referenced ones always; at most 3 subjects otherwise | The long tail is for the dashboard. |
| logs | **never inlined** | Artifacts are paths. |

**Truncation is always declared.** If findings were dropped, the summary gains a
next step saying how many and where the rest are. A silently truncated report is
a report that lies.

Nothing is lost - the full JSON and the SARIF sit beside it, and:

```bash
cq explain 7f3a9c21e4b8      # one finding, in full
cq explain bundle-growth     # one budget, in full
```

That is the design: the agent reads a small document, then asks for the one
thing it is about to fix.

Measured on this repository, a `pr` run over the whole tree:

| | Findings | Size | Approx. tokens |
|---|---|---|---|
| `report.json` | 165 | 173 KB | ~31k |
| `report-agent.json` | 42 | 62 KB | ~11k |
| the same with `newOnly: true`, on a clean change | 0 | 15 KB | ~4k |

The last row is the one that matters, because it is what an agent actually pays
on each iteration of a fix loop: the summary, the budgets, the selection, and
only the findings this change introduced. The middle row is the cost of asking
"show me everything, including the backlog", and the caps are what stop it being
the first row.

Two of the reductions came from measuring rather than guessing. Semgrep puts
several sentences in a SARIF message, so a single finding was 2 KB until titles
were cut to a headline (the full text stays in `detail` and in the artifact);
and the per-analyzer cap is what stops `knip`'s 104 dead-code findings from
being the entire report.

---

## The AI consumption workflow

```
   agent modifies code
            |
            v
   cq run --tier pre-commit --staged          seconds, changed files only
            |
            v
   read .cq/report-agent.json                 ~1-3k tokens
            |
            +-- summary.verdict == "pass"? ---------------> commit
            |
            +-- summary.blockedBy is non-empty?
            |        read summary.nextSteps: each is one actionable sentence
            |
            +-- for each finding:
                     confidence == "low"?          -> leave it for a human
                     fix.safeToAutomate == true?   -> apply it
                     otherwise                     -> read fix.recommendation,
                                                      open finding.where[0],
                                                      cq explain <id> if needed
            |
            v
   cq run --only <the analyzers that reported>    seconds
            |
            v
   repeat until verdict is pass
```

The contract, stated plainly:

1. **The agent reads the report, not the repository.** Every finding carries a
   path, a line, evidence and a recommended fix; that is the whole point of
   normalizing thirty tools into one vocabulary.
2. **`confidence` gates autonomy.** `low` means a human should look.
3. **`safeToAutomate` gates unattended edits.** It defaults to false and is a
   floor across merged findings.
4. **`new` focuses effort.** Pre-existing debt is visible and is not this
   change's job.
5. **`--only` makes iteration cheap.** Naming an analyzer overrides the diff, so
   "re-run exactly what failed" always works.
6. **`skip` is not `pass`.** An agent must not conclude the bundle is fine
   because `bundle-growth` was skipped.
7. **`platformErrors` are not code problems.** Do not try to fix them by editing
   source.

### An exchange

```jsonc
// .cq/report-agent.json, trimmed
{
  "summary": {
    "verdict": "fail",
    "headline": "Blocked by api-call-growth: Network requests on load grew 75.0% against origin/main (now 21, was 12), and the budget allows 25.0%",
    "blockedBy": ["api-call-growth"],
    "nextSteps": [
      "Network requests on load grew 75.0% against origin/main (now 21, was 12), and the budget allows 25.0%",
      "4 of the new findings are marked safe to fix automatically; run `cq fix --safe` or apply each tool's own fixer."
    ]
  },
  "findings": [
    {
      "id": "c41b8ee0d2f37a15",
      "analyzer": "runtime-probe",
      "rule": "runtime/duplicate-request",
      "category": "api",
      "severity": "warning",
      "confidence": "high",
      "title": "/applications requests GET /api/repos 3 times",
      "where": [{ "path": "frontend/src/api.ts", "component": "/applications" }],
      "fix": {
        "recommendation": "Two components asked for the same thing independently. Share one query key so react-query serves both from one request.",
        "safeToAutomate": false,
        "effort": "small"
      },
      "tools": ["runtime-probe"],
      "new": true,
      "tags": ["api-regression", "duplicate-request"]
    }
  ]
}
```

The agent has the endpoint, the screen, the count, the cause and the fix, and it
never opened a log or read a file it was not about to change.
