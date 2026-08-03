# Continuous Quality Platform

A platform that continuously validates quality, performance, reliability,
security, accessibility and developer experience, and produces **one normalized
report** that a person, a pipeline and an AI coding agent all read.

It is an orchestrator, not a toolbox. Every actual check is a mature open source
tool. What is built here is the part nobody sells: deciding what needs to run,
running it cheaply, merging what came back into one vocabulary, and turning that
into a decision with a reason attached.

```
cq run --tier pr --base origin/main
```

## The documents

| | |
|---|---|
| [research.md](research.md) | What Google, Meta, Microsoft, Amazon, Netflix and Stripe actually do, and the five findings that shaped every decision below. |
| [adr/](adr/) | Ten architecture decision records. Each states the alternatives, the evidence, and what would make us change our minds. |
| [architecture.md](architecture.md) | Components, execution flow, the plugin contract, and how a finding travels from a tool to an agent. |
| [tool-selection.md](tool-selection.md) | Every tool, why it was chosen, what it beat, cost, adoption, maintenance and AI-friendliness. |
| [incremental-execution.md](incremental-execution.md) | Change-impact selection and the content-addressed cache: the two things that decide whether this is affordable. |
| [policy-and-reporting.md](policy-and-reporting.md) | The budget engine, the report schema, and the AI consumption workflow. |
| [ci-integration.md](ci-integration.md) | GitHub Actions and Azure DevOps, with complete working pipelines. |
| [operations.md](operations.md) | Scalability, the security model, observability and the roadmap. |

## The shape of it

```
 developer or agent edits code
              |
              v
 +------------------------------------------------------------------+
 |  cq (one static Go binary, no runtime dependencies)               |
 |                                                                   |
 |   impact    -> which analyzers can this change possibly affect?   |
 |   cache     -> which of those already have an answer?             |
 |   schedule  -> run the rest, in parallel, respecting `needs`      |
 |   normalize -> SARIF / JUnit / LCOV / CycloneDX / ... -> Finding  |
 |   dedupe    -> one problem, one finding, however many tools saw it|
 |   score     -> per category and overall                           |
 |   policy    -> budgets, absolute and regression-based             |
 |   report    -> JSON, agent JSON, Markdown, SARIF, JUnit, HTML     |
 +------------------------------------------------------------------+
              |
      +-------+-------+---------------+-----------------+
      v               v               v                 v
 report.json    report-agent.json  report.md      report.sarif
 (archive,       (the agent's       (the PR        (the code
  dashboard)      contract)          comment)       scanning tab)
```

## Five stages, five budgets for time

| Stage | Target | What runs |
|---|---|---|
| `local` | < 30s | formatting, types, vet |
| `pre-commit` | 30-90s | the above plus lint, changed tests, secrets, spec sync |
| `pr` | minutes | everything the diff can affect: tests, coverage, security, bundle, runtime probe, e2e |
| `main` | the full sweep | plus Lighthouse, load test, benchmarks, SBOM, and the baseline is recorded |
| `nightly` | unbounded | mutation testing, deep scans |

A stage is a property of each analyzer's manifest, so moving a check between
stages is a one-line data change, not a code change.

## Quick start

```bash
make cq                    # build the binary into quality/bin/cq
make quality-doctor        # what is installed, what is missing, and how to fix it
make quality-local         # the fast loop
make quality               # the full pull-request stage
```

Nothing needs configuring. `cq` ships with 33 analyzers and 20 budgets built in;
a repository overrides any of it in `cq.yaml`, and a check is added by dropping
one YAML file into a directory. No Go code, no rebuild, no registration.

## What it is not

- **Not a test framework.** It runs yours.
- **Not a linter.** It runs those too, and merges what they say.
- **Not a dashboard product.** It emits open standards, so the dashboards you
  already have can read it.
- **Not a gate on a score.** The score is for the trend line. Merges are decided
  by budgets, which are named, explained, and configurable.
