# CI/CD integration

The same binary, the same report, the same budgets on both platforms. Only the
plumbing differs.

| | GitHub Actions | Azure DevOps |
|---|---|---|
| Pipeline | [`.github/workflows/quality.yml`](../../.github/workflows/quality.yml) | [`.azure/azure-pipelines-quality.yml`](../../.azure/azure-pipelines-quality.yml) |
| Cache | `actions/cache@v4` | `Cache@2` |
| Findings | `codeql-action/upload-sarif` -> Security tab | `CodeAnalysisLogs` artifact -> SARIF viewer extension |
| Budgets as tests | `mikepenz/action-junit-report` | `PublishTestResults@2` |
| Coverage | in the report | `PublishCodeCoverageResults@2` |
| Human summary | `$GITHUB_STEP_SUMMARY` | printed to the log, plus the PR thread |
| PR comment | `actions/github-script`, one comment updated in place | Azure REST API, one thread updated in place |
| Labels | `actions/github-script` | not supported by Azure |

## What each trigger does

```
pull_request        -> cq run --tier pr --base origin/<target>
                       incremental against the merge base
                       comment, labels, SARIF, JUnit, artifacts
                       gate on the verdict

push to main        -> cq run --tier main --full --baseline
                       everything, and it RECORDS THE BASELINE that every
                       subsequent pull request is measured against

schedule (03:00)    -> cq run --tier nightly --full
                       mutation testing and the deep scans
```

## Six things that are easy to get wrong

**`fetch-depth: 0`.** The platform compares against the merge base. A shallow
clone cannot find one, so every regression budget silently degrades to `skip` -
the pipeline stays green and the gates stop existing. This is the single most
important line in either file.

**`continue-on-error` on the run step, and a separate gate step.** The run is
allowed to fail so that the pull request still gets its comment, its labels, its
SARIF and its artifacts. The merge decision is then made *from the report*. A red
build with no explanation is exactly what this platform exists to prevent.

**One job, not a matrix.** The orchestrator already schedules analyzers in
parallel with a dependency graph and a shared cache. Splitting them across
runners means N cache restores, N tool installations and N partial reports to
stitch back together, for the same wall clock. [operations.md](operations.md)
says when that stops being true.

**Pinned tool versions, and pins somebody actually checked.** An unpinned
scanner silently changes what "green" means between two runs of the same commit.
Versions live in `env:`/`variables:` at the top of each file, and the tool
version is part of the cache key, so an upgrade invalidates its own cached
results rather than serving stale ones.

The second half of that sentence is the one that cost a red build. The first
revision of this workflow carried three action versions written from memory: a
`setup-trivy` release that had never existed, and two action major tags that no
longer did. GitHub resolves every `uses:` before it runs anything, so the job
died at "prepare actions" having produced no report at all. **A pin nobody
verified is not a pin, it is a guess with a version number on it** - check each
one against the project's releases, and prefer a first-party action or a pinned
release archive over a third-party action wherever the difference is small.

**Every tool install is `continue-on-error`.** This is the platform's own
contract applied to its own pipeline. A tool that is not present is an explained
skip, named in the report; a job that dies while installing a scanner produces
no report at all, which is strictly worse than a report saying "trivy did not
run: it could not be installed". The gate step still fails the build on a real
budget breach, so nothing is weakened by this - what changes is that a runner
problem stops masquerading as a code problem.

**`cq doctor` runs before `cq run`.** It prints exactly which tools are present.
A missing tool is a skip, not a pass - so the doctor output is the record of how
much coverage that run actually had, and it is what makes the line above safe.

## Labels

Labels come from analyzer **tags**, so adding a label means adding a tag to a
manifest, not editing the workflow:

```
performance-regression   accessibility        security
api-regression           backend-performance  frontend-performance
visual-regression        flaky-tests          bundle-regression
quality-pass
```

Only labels this workflow manages are ever touched, so a human's own labels
survive. A label is applied only when the platform actually said the thing: tags
on **new** findings, plus the category of any failed budget.

## Branch protection

Require these checks on `main`:

- `Quality / Pull request` - the gate
- `Quality budgets` - the JUnit check run, so a failing budget is visible by name

The pull-request stage is incremental; `main` runs full. That asymmetry is
deliberate: incremental selection is an optimization for feedback speed, never
the record of whether the trunk is healthy.

## Local, and pre-commit

```bash
make cq                 # build quality/bin/cq
make quality-doctor     # what is installed, what is missing, how to fix it
make quality-local      # < 30s: formatting, types, vet
make quality-precommit  # 30-90s, staged files only
make quality            # the full pull-request stage
make quality-plan       # what would run, and why, without running it
make quality-baseline   # record the current state as the baseline
```

The pre-commit hook (`scripts/hooks/pre-commit`, installed by `make hooks`)
already regenerated the OpenAPI spec; it now also runs the `pre-commit` tier over
the staged files. Two escape hatches, both documented in the hook itself:

```bash
SKIP_CQ=1 git commit ...      # skip the quality check for one commit
git commit --no-verify ...    # skip every hook
```

The hook is deliberately forgiving about its own failures: if `cq` is not built,
or a tool is missing, it says so and lets the commit through. A hook that blocks
work because of its own installation problem gets uninstalled.

## Container image

```dockerfile
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY quality/ ./quality/
RUN cd quality && CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X github.com/abhijeet-oxide/configer/quality/internal/cli.Version=$(git describe --tags --always 2>/dev/null || echo dev)" \
      -o /out/cq ./cmd/cq

FROM alpine:3.21
RUN apk add --no-cache git nodejs npm go make curl bash
COPY --from=build /out/cq /usr/local/bin/cq
# Analyzers install here, each pinned and checksummed.
ENTRYPOINT ["cq"]
```

`CGO_ENABLED=0` and `-trimpath` give a static, reproducible binary. The analyzer
catalog is embedded, so the image needs no manifest directory and nothing can
drift between the binary and its plugins.
