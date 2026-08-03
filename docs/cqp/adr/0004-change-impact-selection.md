# ADR-0004: Path scopes plus git diff, not a build graph

**Status:** Accepted

## Context

Incremental execution is the whole cost model. Everything else in the platform is
a constant factor; this decides whether a pull request costs twenty seconds or
twenty minutes, and whether a documentation change costs anything at all.

Meta's and Google's answer at their scale is a build graph: every target's inputs
are known, so "what can this diff affect" is a graph query. That is the correct
answer and it is expensive to adopt.

## Decision

Two-level selection, both declarative:

1. **Scopes.** `cq.yaml` maps path globs onto coarse areas (`frontend`,
   `backend`, `api`, `infra`, `ci`, `deps`, `docs`). A change is classified into
   the set of areas it touches.
2. **Triggers.** An analyzer declares `scopes:` and/or `paths:`. It runs if
   either matches.

Plus four rules that matter more than the mechanism:

- **`alwaysRun`** opts out entirely. Secret scanning and dependency scanning use
  it, because a credential can be pasted into a Markdown file and a lockfile can
  become vulnerable without anybody touching it.
- **An unclassified path selects everything.** Silence over a file the repository
  has not mapped is the one failure mode of incremental selection that actually
  hurts.
- **Documentation-only changes skip code checks**, explicitly and by name, because
  it is the most common change shape in a healthy repository.
- **Prerequisites come along.** A bundle measurement without its build is not a
  cheaper answer, it is no answer.
- **`main` always runs full.** Incremental selection is an optimization for
  feedback speed, never the record of whether the trunk is healthy.

Every skip carries a sentence, and `cq plan` prints the whole decision without
running anything.

## Alternatives considered

**Bazel.** Correct, hermetic, and it would give perfect incremental execution and
remote caching for free. Rejected on adoption cost: it means rewriting the Go and
npm builds in Starlark, and the repository is one Go module and one Vite app.
**Nx or Turborepo.** `nx affected` is exactly this problem solved well - for a
JavaScript monorepo. Half of this repository is Go, and a Node-based orchestrator
was rejected in ADR-0002.
**Go's own `go list -deps` for backend selection.** Genuinely better than path
globs for Go. Deferred rather than rejected; see below.
**Run everything, always.** Honest and simple. Rejected on the numbers: the full
pull-request stage here is minutes, and an agent fix loop pays it per iteration.

## Consequences

- Selection is coarse. A change to one Go file runs every Go check, not just the
  packages that depend on it.
- Coarse in the safe direction: over-selection costs time, under-selection costs
  correctness, and the rules above all resolve toward over-selection.
- The mapping is repository knowledge that lives in `cq.yaml`, where it is
  reviewable, rather than in the orchestrator.

## What would change our minds

Two triggers, either of which flips this:

- The full pull-request stage regularly exceeding ten minutes. At that point
  per-package selection (`go list -deps` on the backend, the Vite module graph
  on the frontend) pays for itself, and the `Selector` interface is the seam.
- The repository becoming a genuine monorepo with several deployables. That is
  the point at which Nx or Bazel stops being over-engineering.
