# ADR-0005: A content-addressed result cache

**Status:** Accepted

## Context

The agent workflow is a loop: run checks, read the report, fix, re-run. Without
a cache, every iteration pays for every analyzer, including the twenty that could
not possibly have been affected by the edit. That cost is paid in wall-clock
time, in CI minutes, and - because the agent waits for the report - in tokens.

## Decision

Cache the **normalized result**, keyed by a hash of everything that could change
it:

- the analyzer id
- the tool's own version string (so upgrading a linter invalidates its results)
- the exact command line and environment
- a digest of the repository's `cq.yaml` and the tier
- the content hash of every file matching the analyzer's declared `cache.inputs`

Every component is length-prefixed before hashing, so no combination of values
can collide by concatenation - the classic way a hand-rolled cache key silently
returns the wrong answer.

An analyzer that declares no `cache.inputs` is never cached. That is the safe
default: caching is opt-in per manifest, by the person who knows what the tool
actually reads.

## Alternatives considered

**Cache by git SHA.** Trivial and wrong: an uncommitted edit produces a hit, and
two branches with identical content miss each other.
**Cache the raw tool output and re-normalize.** Marginally more flexible.
Rejected: the artifact is already on disk if anybody wants it, and re-parsing a
40 MB SARIF file on every hit is most of what the cache was meant to avoid.
**Rely on the tools' own caches** (golangci-lint, tsc `--incremental`, ESLint
`--cache`). They are used where present, and they are not enough: they do not
cache across a `--only` re-run, they do not cache the normalization, and they
have nothing to say about an analyzer that is a shell script.

## Consequences

- Storing normalized results means an upgrade to a normalizer must invalidate
  the cache. The key includes a `v1` prefix for exactly that.
- A cache write failure is swallowed. The cache is an optimization and may never
  be the reason a quality run fails.
- Writes are atomic (temp file plus rename), so a cancelled run never leaves a
  half-written entry a later run would trust.
- `Prune` exists because a CI cache restored from a slowly-changing key grows
  without bound until the restore itself becomes the slow step.

## What would change our minds

A shared remote cache would be the next step if several developers and CI were
repeatedly computing the same answers. The `Cache` type is an interface-shaped
struct precisely so an S3 or Redis backing can be added without touching the
engine.
