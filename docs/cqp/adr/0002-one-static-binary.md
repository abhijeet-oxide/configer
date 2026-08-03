# ADR-0002: One static Go binary with near-zero dependencies

**Status:** Accepted

## Context

The orchestrator runs in three places with very different constraints: a
developer's pre-commit hook (where a two-second startup is unacceptable), a CI
runner (where every dependency is a supply-chain surface and a cache miss), and
an agent loop (where it may run dozens of times per task).

## Decision

The orchestrator is a single Go binary. Its only module dependency is
`gopkg.in/yaml.v3`, which the repository already depends on. The analyzer
catalog is embedded with `go:embed`, so the binary is self-sufficient: no
manifest directory to copy onto a runner, nothing to drift.

It lives in its own Go module (`quality/`), separate from `backend/`.

## Alternatives considered

**Node.js.** The frontend toolchain is already Node, and most of the analyzers
are npm packages. Rejected: a `node_modules` tree in a pre-commit hook is a
cold-start cost and a dependency surface, and the platform must work on a
repository with no frontend at all.

**Python.** Excellent library ecosystem for report manipulation. Same objection,
plus a runtime that CI images do not reliably pin.

**Put it in `backend/`.** Simpler CI. Rejected: the quality platform must never
become a dependency of the shipped product binary, and `backend/internal/` is
the product's domain. A separate module makes that structural rather than
conventional.

**Add a CLI framework (cobra, urfave/cli).** Rejected: the command surface is
seven commands, `flag` covers it, and a CLI that needs a framework is usually a
CLI that needs fewer commands.

## Consequences

- CI needs a second `setup-go` working directory. Small and explicit.
- No dependency updates to chase, no transitive CVE surface of our own. The
  platform that reports supply-chain risk does not add much.
- Cross-compilation is free, so a Windows or macOS developer gets the same
  binary behaviour as the Linux runner.

## What would change our minds

A requirement for something genuinely hard in Go and easy elsewhere - rendering
a rich interactive dashboard, say. The HTML reporter deliberately stays static
to avoid exactly that pull.
