# ADR-0001: Build an orchestrator, not another test framework

**Status:** Accepted

## Context

The requirement is comprehensive validation across formatting, linting, types,
React performance, accessibility, bundle size, backend profiling, load, security,
supply chain, infrastructure and API contracts, for a React + Vite frontend and a
Go backend, running incrementally, in CI, and consumable by AI agents.

The obvious failure mode is to write a framework: a test runner with plugins for
each of those concerns. Every one of those concerns already has at least one
mature open source tool with more investment behind it than this project will
ever have.

## Decision

Build **only** the parts nobody sells:

- change-impact selection
- scheduling with dependencies and parallelism
- a content-addressed result cache
- normalization from tool formats into one vocabulary
- deduplication across overlapping tools
- scoring and the budget policy engine
- report generation for people, pipelines and agents

Everything that actually inspects code is an existing tool, invoked as a
subprocess, read through its machine-readable output.

## Alternatives considered

**Adopt a hosted platform (SonarQube, Codacy, DeepSource).** They cover static
analysis well and nothing else in the list: no bundle budget, no load test, no
runtime probe, no SBOM, no agent-shaped report. They also own the findings, which
puts the AI contract behind an API and a licence.

**Write a monolithic `make quality` target.** This is what the repository had.
It works until the suite takes long enough that people stop running it locally,
at which point there is no incremental story, no cache, no baseline, no
deduplication and no machine-readable output. The Makefile is still there; `cq`
is what it calls.

**Use a build system as the orchestrator (Bazel, Nx, Turborepo).** Genuinely
attractive: they solve caching and incremental execution properly. Rejected for
now in ADR-0004, on cost of adoption rather than on merit.

## Consequences

- The platform's quality ceiling is the tools' quality ceiling. Accepted: they
  are better than anything that would be written here.
- A missing tool must be a first-class state, not a failure. `cq doctor` names
  every missing tool with its install line, and a skipped analyzer appears in
  the report as skipped, never as passed.
- The orchestrator must be honest about what it did not run, because "it was
  green" now depends on which tools happened to be installed.

## What would change our minds

A single tool appearing that credibly covers frontend performance, backend
profiling, security and supply chain with one machine-readable output and an
agent-shaped API. Nothing close exists.
