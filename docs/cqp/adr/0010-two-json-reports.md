# ADR-0010: Two JSON reports, the archive and the agent contract

**Status:** Accepted

## Context

The requirement is a report "optimized for minimal LLM token consumption" that
is also the dashboard's input and the run's archive. Those are different
documents. A full run on a large repository produces thousands of findings; an
agent handed all of them will summarize them badly and fix none of them, and pay
for the privilege on every iteration of its fix loop.

## Decision

Write both, from the same in-memory report.

**`report.json`** is complete: every finding, every metric, every analyzer's
timing and cache state. It is the archive, the dashboard's input, and what
`cq explain` reads.

**`report-agent.json`** is the contract with an agent. Against the full report it:

- drops findings below the configured severity floor
- optionally drops findings already in the baseline (`newOnly`) - a change is
  answerable for what it added
- caps the total (default 120) **and** the per-analyzer count (default 25), so
  one noisy linter cannot crowd out the security scanner
- truncates evidence to a quotation and detail to a sentence
- drops the per-analyzer timing table, which is operator data
- keeps every metric a budget references, and at most three subjects of any other
- **never inlines a log**; artifacts are paths

Nothing is lost. The full JSON and the SARIF sit next to it, and `cq explain
<id>` expands any single finding on demand. That is the whole design: the agent
reads a small document, then asks for the one thing it is about to fix.

**Truncation is always declared.** If findings were dropped, the summary says so
and says where the rest are. A silently truncated report is a report that lies.

## Alternatives considered

**One report with a `?fields=` style projection.** Requires the consumer to know
what to ask for. The default has to be right.
**Emit only the agent report.** Loses the archive, and the dashboard.
**Compress rather than truncate.** Solves bytes, not tokens. The model still
reads every finding.
**Let the agent read SARIF.** SARIF is verbose by design - rules and results are
separate, locations are deeply nested - and it carries no metrics, no budgets and
no verdict. It is the right format for a code scanning tab and the wrong one for
a prompt.

## Consequences

- Two files to keep consistent. They are generated from one struct by one
  function, so they cannot disagree about facts, only about completeness.
- The caps are configuration, so a repository that wants everything sets
  `maxFindings: 0`.
- `report.Sort()` puts the report in canonical order, so two runs over identical
  code produce byte-identical output and the report itself diffs cleanly.

## What would change our minds

Nothing about the split. The specific caps are guesses and should be tuned from
observed agent behaviour: the number that matters is how many findings an agent
fixes correctly in one pass, and that is measurable.
