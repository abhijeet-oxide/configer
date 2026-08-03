# Research findings

What large engineering organizations actually do, and the five conclusions that
shaped every decision in this platform. Sources are linked at the end.

---

## Google

**Tricorder** is the closest published analogue to what this platform is, and it
is the single most useful input to the design. It analyzes more than 50,000 code
review changes a day across 30-plus languages with more than 100 analyzers, and
it survived where several earlier attempts at Google failed.

The published lessons, and what each one did to this design:

| Google's finding | Consequence here |
|---|---|
| The effective false-positive rate across all analyzers is **just below 5%**, and a new analyzer must stay under **10%** to be admitted. Developers stop reading a channel that cries wolf. | Every finding carries an explicit `confidence`, set per-analyzer in a reviewed manifest rather than guessed per finding. Low-confidence findings are penalized less in scoring and are the first thing dropped from the agent-facing report. |
| A new check must be **understandable to any engineer**, **actionable**, under the false-positive bar, and have real quality impact. | The manifest schema forces a `recommendation` and an `effort`, and `cq doctor` fails a manifest that omits the install line. A finding with no fix is not a finding. |
| Integration point matters more than analysis quality. In priority order: **compiler > code review > presubmit > IDE**. | The five-tier model. The cheapest, most certain checks (formatting, types, vet) run at `local`; everything else is placed by how confident and how expensive it is. |
| Analyzers with a high "Not useful" rate get **disabled**. Accountability runs from the analysis author to the user. | `enabled: false` per analyzer in `cq.yaml`, and every budget can ship `blocking: false` so a new gate is measured before it can stop anybody. |
| Automated fixes are applied ~3,000 times a day. Mechanical fixes are the highest-leverage output. | `fix.safeToAutomate` is a first-class field, derived from the tool's own signal where one exists (ESLint's `fix`), and it is the field an agent branches on. |

The plugin model is the other borrowed idea. Tricorder succeeded because
engineers across Google could write analyses through a simple API without being
static-analysis specialists. Here the API is a YAML file, which is a lower bar
still.

## Microsoft

The **L0-L4 test taxonomy** classifies tests by what they touch and how long
they may take, with explicit execution-time requirements per level. The
insight worth stealing is not the specific levels but that **time budget is a
property of the stage, and every check declares which stage it belongs to** -
rather than a pipeline that runs everything and hopes.

Azure DevOps' multi-stage YAML pipelines with approval gates between stages is
the model the Azure pipeline in [ci-integration.md](ci-integration.md) follows.
Its SARIF viewer extension and `PublishTestResults@2` (JUnit, Cobertura) are why
this platform emits those two formats rather than only its own.

## Amazon

The quality-gate philosophy visible in Amazon's published CI/CD practice is
**pipelines as code with automatic rollback and per-stage promotion**: a change
does not advance until the gate for the stage it is in has passed, and each gate
is cheap enough not to be the bottleneck.

The relevant borrowing is the promotion model: `main` runs everything and
**records the baseline**, and a pull request is measured against that baseline
rather than against an absolute standard. That is what makes the gate meaningful
on a repository that already has debt.

## Meta

Meta's engineering tooling is built around a very large monorepo, and the
consistent theme across what they have published is **incremental everything**:
build, test selection, and analysis are all driven by a dependency graph, and
the question is never "run the suite" but "what can this diff possibly affect".

That is exactly the [incremental execution](incremental-execution.md) design.
The scale here is smaller, so the implementation is proportionate: path scopes
plus git diff plus a content-addressed cache, rather than a full build graph.
ADR-0004 states what would justify moving to Bazel or Nx.

## Netflix

Netflix's pipeline is Jenkins for CI into Spinnaker for CD, with quality
enforced at the deploy boundary (canaries, automated analysis, Chaos Monkey)
rather than only at the merge boundary.

The borrowing is narrower: **verification is a stage, not an afterthought**, and
the artifact promoted between stages is the same artifact that was verified.
Here that shows up as the build being an analyzer in its own right, with the
bundle measurement declaring `needs: [frontend-build]` so nothing measures a
tree that did not build.

## Stripe

Stripe's published engineering practice emphasizes **API contracts as
first-class artifacts**: an OpenAPI specification that is generated, versioned,
and checked for backward compatibility, because a published response field is a
promise to code you cannot see.

That produced two analyzers: `oasdiff` for breaking-change detection and
`spectral` for spec quality. It also produced the `no-breaking-api-changes`
budget with a limit of zero, which is one of the few absolute blocking budgets
that ships on by default.

## GitHub

**SARIF is the de facto interchange format**, because GitHub's code scanning tab
ingests it natively and every serious scanner emits it. That single fact
collapses most of the normalization problem: one SARIF reader covers
golangci-lint, Semgrep, Trivy, Gitleaks, OSV-Scanner, govulncheck, Checkov,
Hadolint and KubeLinter.

GitHub Actions also fixes the practical shape of CI integration: `actions/cache`
keyed on lockfile hashes, `upload-sarif` for findings, `$GITHUB_STEP_SUMMARY`
for the human summary, and artifact upload for everything else.

## CNCF / OpenTelemetry

The **CI/CD Observability SIG** landed semantic conventions for CI/CD in
OpenTelemetry (`cicd.pipeline.*`, a SERVER span per run and INTERNAL spans per
task) in semconv v1.27. A platform that measures other people's software and
cannot measure itself has no standing; this platform emits those spans.

It emits them as OTLP/JSON without linking the OpenTelemetry SDK. ADR-0009
explains that trade.

---

## The five conclusions

Everything in this repository follows from these.

### 1. The integration point matters more than the analysis

Tricorder's own account is that it succeeded where better analyses had failed,
because it put results where developers were already in a change mindset. So the
platform's primary output is not a dashboard, it is a **pull request comment and
a machine-readable contract**, and the fastest checks run before a commit exists.

### 2. False positives are the failure mode, not false negatives

A missed finding costs one defect. A false positive costs the credibility of
every finding after it, and with an agent in the loop it costs a wrong edit.
Hence: explicit confidence, per-analyzer automation-safety, corroboration
between tools raising confidence, and `safeToAutomate` defaulting to false.

### 3. Regression beats threshold

An absolute threshold is unreachable on day one or meaningless on day one
hundred. "Not worse than the branch you are merging into" is always both
achievable and meaningful. So the blocking budgets are regression budgets, the
absolute ones ship advisory, and a regression budget with no baseline reports
**skip** rather than pass. (Reporting pass would silently disable the gate on
every new branch, which is exactly when people trust it most.)

### 4. Incremental selection is the whole cost model

Everything else is a constant factor. A documentation change must cost seconds.
The decision must be **visible** (`cq plan` prints it, and every skip carries a
sentence), because a platform that silently skips work is a platform nobody
believes.

### 5. Do not build what exists

The only custom components are orchestration, selection, caching, normalization,
deduplication, policy and reporting - the parts no vendor sells and no open
source project does end to end. Every actual analysis is a mature tool. The one
genuine exception is the runtime probe, and ADR-0008 defends it narrowly: no
off-the-shelf tool answers "did this screen fetch the same thing twice", and
even there Playwright does the driving and axe-core does the analysis.

---

## Sources

- [Tricorder: Google's Static Analysis Platform (Software Engineering at Google, ch. 20)](https://abseil.io/resources/swe-book/html/ch20.html)
- [Lessons from Building Static Analysis Tools at Google, CACM 2018](https://m-cacm.acm.org/magazines/2018/4/226371-lessons-from-building-static-analysis-tools-at-google/fulltext)
- [Tricorder: Building a Program Analysis Ecosystem, ICSE 2015](https://research.google/pubs/tricorder-building-a-program-analysis-ecosystem/)
- [SARIF support for code scanning, GitHub Docs](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning)
- [SARIF 2.1.0, OASIS](https://sarifweb.azurewebsites.net/)
- [Semantic conventions for CI/CD spans, OpenTelemetry](https://opentelemetry.io/docs/specs/semconv/cicd/cicd-spans/)
- [OpenTelemetry is expanding into CI/CD observability, CNCF](https://www.cncf.io/blog/2024/11/04/opentelemetry-is-expanding-into-ci-cd-observability/)
- [oasdiff: OpenAPI diff and breaking changes](https://github.com/oasdiff/oasdiff)
- [Knip](https://knip.dev/)
- [Gremlins: mutation testing for Go](https://github.com/go-gremlins/gremlins)
- [kubeconform](https://github.com/yannh/kubeconform)
- [Performance budgets in the build process, web.dev](https://web.dev/incorporate-performance-budgets-into-your-build-tools/)
- [18 CI/CD pipeline examples from large engineering organizations](https://www.devopstraininginstitute.com/blog/18-cicd-pipeline-examples-from-big-tech-companies)
- [Netflix DevOps case study, Carnegie Mellon SEI](https://www.sei.cmu.edu/blog/devops-case-study-netflix-and-the-chaos-monkey/)
