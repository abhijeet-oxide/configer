# Incremental execution and caching

The two mechanisms that decide whether this platform is affordable. Everything
else is a constant factor.

## Change-impact selection

### The decision, in order

```
for each analyzer in the catalog:

  disabled in cq.yaml?                 -> skip, "disabled in cq.yaml"
  not in this tier?                    -> skip, "not part of the pr tier"
  --only given and not named?          -> skip, "not requested by --only"
  --only given and named?              -> RUN (naming it overrides the diff)

  alwaysRun: true?                     -> RUN
  --full?                              -> RUN
  nothing changed?                     -> skip, "nothing changed"

  documentation-only change?
      declares the docs scope?         -> RUN
      otherwise                        -> skip, "only documentation changed"

  declares neither scope nor path?     -> RUN (repository-wide by construction)
  its scope is in the changed set?     -> RUN
  an unclassified path changed?        -> RUN (be conservative about the unknown)
  a changed file matches its paths?    -> RUN

  otherwise                            -> skip, "no change under backend"

then: pull in every selected analyzer's `needs`, transitively
then: order heaviest first
```

Every skip carries that sentence, and it reaches the report. `cq plan` prints
the whole decision without running anything, which is the answer to "why didn't
the accessibility check run on my PR".

### The base ref is the merge base

```
git merge-base origin/main HEAD     ->  M
git diff --name-status M...HEAD
```

Not the branch tip. A pull request is answerable for what **it** changed, not for
what landed on main while it was open. Using the tip would spuriously widen every
open change's blast radius every time the trunk moved.

Uncommitted work is folded in too, so `cq run --base origin/main` on a laptop
sees what the developer is actually about to push. `--staged` narrows to the git
index, which is what a pre-commit hook must look at: the working tree may hold
work that was deliberately not staged.

### Scopes

```yaml
scopes:
  frontend: ["frontend/**"]
  backend:  ["backend/**"]
  api:      ["backend/internal/api/**", "frontend/src/api.ts"]
  infra:    ["deploy/**", "**/Dockerfile", "**/kustomization.yaml"]
  ci:       [".github/**", ".azure/**", "scripts/**", "Makefile"]
  deps:     ["**/go.mod", "**/go.sum", "**/package*.json"]
  docs:     ["**/*.md", "docs/**"]
```

A file may land in several scopes - `backend/internal/api/reads.go` is both
`backend` and `api` - and that is the point: an API handler change should run the
backend checks *and* the contract checks.

A file matching nothing lands in `other`, which selects **everything**. Silence
over a path the repository has not mapped is the one failure mode of incremental
selection that actually hurts, so the rule resolves toward over-selection.

### The worked examples

| Change | Areas | Runs | Skips |
|---|---|---|---|
| `backend/internal/api/reads.go` | backend, api | golangci-lint, go vet, gofmt, go test, coverage, govulncheck, openapi-sync, oasdiff, spectral, smoke, runtime probe, secrets, deps | every frontend check |
| `frontend/src/components/Grid.tsx` | frontend | eslint, tsc, build, bundle-size, depcruise, knip, playwright, runtime probe, secrets, deps | every backend check |
| `frontend/src/styles.css` | frontend | the frontend set (path-triggered ones filter to CSS) | all backend |
| `README.md`, `docs/**` | docs | secrets, house style | **everything else** |
| `backend/go.sum` | deps, backend | trivy, osv-scanner, govulncheck, sbom, plus the backend set | frontend |
| `some/unmapped/thing.conf` | other | **everything** | nothing |

### Per-file invocation

An analyzer with `changedFilesArg` receives only the changed files it cares
about, filtered by its own `paths` - handing a Go linter a list of TypeScript
files is how per-file invocation usually goes wrong. `maxChangedFiles` falls back
to a whole-tree run once the diff is large enough that per-file invocation stops
being the cheaper option (ESLint: 60 files).

### `main` always runs full

Incremental selection is an optimization for feedback speed, never the record of
whether the trunk is healthy. The default branch runs `--full`, records the
baseline, and is the thing every pull request is measured against.

---

## Caching

### The key

```
sha256(
   "v1"
   analyzer id
   tool version           <- an upgraded linter invalidates its own results
   command + args
   env (sorted)
   digest(cq.yaml, version, tier)
   for each file matching cache.inputs, sorted:
       path + sha256(content)
)
```

Every component is length-prefixed before hashing, so no combination of values
can collide by concatenation. That is the classic way a hand-rolled cache key
silently returns the wrong answer, and it is worth the four extra characters.

### What is stored

The **normalized result** - findings and metrics - not the raw tool output.
Re-parsing a large SARIF file on every hit is most of what the cache was meant to
avoid, and the raw artifact is still on disk if anybody wants it.

### Opt-in per analyzer

An analyzer that declares no `cache.inputs` is **never cached**. That is the safe
default: the person who knows what a tool actually reads is the person writing
its manifest. Anything whose answer depends on something unhashable - wall clock,
a network service, a running server - sets `cache.disabled: true` explicitly.
The runtime probe, load test, benchmarks, Lighthouse and oasdiff are all
uncached for that reason.

### Safety

- Writes are atomic (temp file, then rename), so a cancelled run never leaves a
  half-written entry that a later run would trust.
- A cache failure is swallowed: creating the directory, reading, writing. The
  cache is an optimization and may never be the reason a quality run fails.
- Two hex characters of fan-out in the directory layout, so a long-lived cache
  does not become one enormous flat listing.
- `Prune(maxAge)` exists because a CI cache restored from a slowly-changing key
  grows without bound until the restore itself becomes the slow step.

### In CI

```yaml
- uses: actions/cache@v4
  with:
    path: .cq/cache
    key: cq-${{ runner.os }}-${{ hashFiles('backend/go.sum','frontend/package-lock.json') }}-${{ github.sha }}
    restore-keys: |
      cq-${{ runner.os }}-${{ hashFiles('backend/go.sum','frontend/package-lock.json') }}-
      cq-${{ runner.os }}-
```

The three-level restore chain matters: an exact hit is ideal, a same-dependency
hit is nearly as good, and any hit at all beats a cold start on the analyzers
whose inputs did not move.

---

## The agent loop, costed

This is what the two mechanisms are for.

Measured on this repository, `cq run --tier pr --base main`, 29 analyzers:

```
iteration 1   cold cache, everything runs                    53.6 s
              agent reads report-agent.json                  ~11k tokens

iteration 2   cq run --only eslint,typescript
              2 analyzers, and only those                    ~25 s
              (both were cache misses: their inputs moved)

iteration 3   nothing changed since iteration 1
              29 analyzers, 18 cache hits, 0 misses           1.8 s
```

**53.6 s to 1.8 s** on an unchanged tree, and the eleven analyzers that are not
in that count are the ones that correctly refuse to cache: a bundle measurement,
a browser probe, a load test. The cache stores the normalized result, so a hit
costs a file read rather than a tool invocation and a re-parse.

Without selection, iteration 2 is the full 53 seconds. Without caching, so is
iteration 3. Together they are the difference between an agent loop that costs a
full CI run per iteration and one that costs what it actually changed.

The 1.8 s figure is also how the bug that produced it was found: the cache
reported 0 hits and 18 misses over two identical runs, because `Put` renamed
into a fan-out directory it never created and swallowed the error. A cache that
silently does nothing looks exactly like a cache that is working, which is why
`cacheHits` and `cacheMisses` are in every report.
