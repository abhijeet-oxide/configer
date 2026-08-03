# ADR-0006: Open standards in, open standards out

**Status:** Accepted

## Context

Thirty-odd tools each have an output format. A platform that invents its own
interchange format for them to be converted into has invented a format that
exactly one thing reads.

## Decision

**In:** read the standard formats the tools already emit, and choose tools that
emit them. SARIF, JUnit XML, LCOV, Go's coverage profile, Cobertura, CycloneDX,
Lighthouse's LHR, k6's summary, benchstat CSV.

The leverage is concentrated. **SARIF alone carries golangci-lint, Semgrep,
Trivy, Gitleaks, OSV-Scanner, govulncheck, Hadolint and KubeLinter** - eight
tools, one normalizer, eight YAML files. JUnit carries every test runner in
existence.

**Out:** emit the standards the ecosystem already consumes.

| Format | Who reads it |
|---|---|
| SARIF 2.1.0 | GitHub code scanning, Azure DevOps SARIF viewer, VS Code, security dashboards |
| JUnit XML | every CI system's test panel |
| CycloneDX | SBOM tooling, licence compliance, vulnerability management |
| JSON | dashboards, the archive, agents |
| Markdown | the pull request |
| HTML | a person |

The one proprietary artifact is the JSON report schema, and it is documented,
versioned (`schema: "1.0.0"`) and published as JSON Schema in
`quality/schema/report.schema.json`.

## Alternatives considered

**Convert everything to SARIF and stop.** Tempting, and it fails on the half of
this platform that is measurements rather than findings. SARIF has no way to say
"the p95 latency is 214ms and it was 190ms on main". Metrics need their own
model, and once there is a report type carrying metrics, findings live there too.
**Emit only our own JSON and let consumers convert.** Every consumer writes the
same converter. The whole point of a standard is that this already happened.
**SPDX instead of CycloneDX for the SBOM.** SPDX is the better licence-compliance
archive and is an ISO standard. CycloneDX wins here because it carries
components, vulnerabilities and licences in ONE document, so a single artifact
answers three questions. Syft emits both; switching is a one-line manifest change.

## Consequences

- Findings appear in GitHub's Security tab and annotate the diff, without anybody
  configuring a dashboard.
- Budget results appear in the CI test panel, because they are projected onto
  JUnit - one test case per budget. Findings deliberately are **not** test cases:
  a panel with four thousand entries is a panel nobody opens.
- Reading eleven input formats is eleven parsers to maintain. Each is small,
  each is exercised by the shipped catalog, and the alternative is worse.

## What would change our minds

SARIF gaining a first-class measurement model, which would collapse the report
schema into it. There is no sign of that.
