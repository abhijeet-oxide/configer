# ADR-0003: Analyzers are data, normalizers are code

**Status:** Accepted

## Context

"Adding a new analyzer should require minimal code changes." The naive plugin
system is a Go interface plus a registration call, which means adding a tool
requires writing Go, compiling it, and shipping a new binary. That is a bar high
enough that most teams will not clear it, and the checks that never get added
are the repository-specific ones that would have been most valuable.

## Decision

Two different things, treated differently:

**A TOOL is data.** One YAML manifest declares its id, category, tags, stages,
scopes, path triggers, command, probe, timeout, cost, cache inputs, dependencies
and finding defaults. There is no Go code, no registration, no rebuild. Manifests
are embedded for the built-in catalog and loaded from `analyzerDirs` for a
repository's own.

**A FORMAT is code.** A normalizer is a Go function registered by format name.

This split is what keeps the catalog cheap. The 33 shipped analyzers need 19
normalizers, and one of those - SARIF - carries eight tools by itself. The rule
is stated in the code and enforced by convention: if a second tool ever speaks a
format, it gets promoted from the shared adapter script to a normalizer.

## Alternatives considered

**A Go interface per analyzer.** Maximum flexibility, unusable adoption cost.
**A shell script per analyzer.** Zero structure: no way to declare a cache key, a
stage, a cost or a dependency, so the orchestrator could not schedule or cache
anything.
**WASM plugins.** Genuinely sandboxed and genuinely portable. Enormous machinery
for a problem whose answer is "run this command and read this file".

## Consequences

- A malformed manifest must not take the platform down. Catalog load collects
  problems rather than failing, and `cq doctor` is where they are read.
- Manifest mistakes that would surface at runtime are checked at load: unknown
  category, unknown tier, missing command, unknown output format, dangling
  `needs`, dependency cycles.
- The shipped catalog is tested (`catalog_test.go`): every manifest validates,
  declares a known format, carries an install sentence and a cost, and no heavy
  analyzer is allowed into the `local` or `pre-commit` tiers.
- Manifests can shell out (`command: sh`), which is an escape hatch that could
  be abused into unreviewable pipelines. Accepted, with the convention that
  anything past one pipe belongs in `scripts/cq/`.

## What would change our minds

Manifests growing conditionals. The moment a manifest needs an `if`, it wants to
be a script, and the honest answer is to move the logic into `scripts/cq/` and
keep the manifest declarative.
