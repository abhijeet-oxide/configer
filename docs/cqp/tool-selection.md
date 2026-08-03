# Technology selection

Every tool, what it beat, and why. Costs are order-of-magnitude on this
repository's size; treat them as scheduling hints, not benchmarks.

The selection criteria applied throughout: actively maintained, production
proven, widely adopted, container and CI friendly, **machine-readable output**,
Linux compatible, permissively licensed. Machine-readable output is not
negotiable - a tool that only prints to a terminal cannot participate.

---

## Formatting

| | |
|---|---|
| **Chosen** | `gofmt` (Go), ESLint's formatting rules (TS) |
| **Considered** | Prettier, Biome, gofumpt |
| **Why** | Go has one formatting, it is not configurable, and disagreeing with it is not a position anybody holds. On the TypeScript side the repository already runs ESLint; adding Prettier means a second tool, a second config, and a class of conflict between them. Biome would replace both and is genuinely faster - see the linting row for why not yet. |
| **Cost** | < 200ms |
| **AI-friendliness** | High. `safeToAutomate: true`, `effort: trivial`: the fix is `gofmt -w`. |

## Linting and static analysis (Go)

| | |
|---|---|
| **Chosen** | `golangci-lint` v2 |
| **Considered** | staticcheck alone, `go vet` alone, revive, Semgrep alone |
| **Why** | It is not a linter, it is a **runner for about a hundred of them** (staticcheck, govet, errcheck, ineffassign, gocritic, bodyclose, ...) behind one configuration, one cache and one SARIF output. Running those separately would mean a hundred manifests, a hundred processes and a hundred caches for identical findings. |
| **Cons** | A heavy binary, and a version bump occasionally changes findings. Mitigated by pinning (`v2.5.0` in CI) and by the tool version being part of the cache key. |
| **Adoption / maintenance** | The de facto standard for Go CI; very active. |
| **Cost** | 10-60s cold, seconds warm (it has its own cache too) |
| **CI** | `golangci/golangci-lint-action@v8` |
| **AI-friendliness** | High. SARIF with rule ids, precise locations and help text. |

`go vet` is **also** kept as its own analyzer even though golangci-lint runs it.
It ships with the Go distribution, so on a machine with no linter installed it is
still a real check - and when both run, the deduplicator merges their findings
and records that two tools agreed, which raises confidence rather than
duplicating output.

## Linting (TypeScript / React)

| | |
|---|---|
| **Chosen** | ESLint 10 with `eslint-plugin-react-hooks` |
| **Considered** | Biome, oxlint, deno lint |
| **Why** | Biome and oxlint are 10-100x faster and would be the right answer on speed alone. They lose on the thing that matters most here: **the React ecosystem's correctness rules exist only in ESLint**. `react-hooks/exhaustive-deps`, `rules-of-hooks`, and the React Compiler's own lint rules are precisely what catches the re-render and memoization mistakes generated code makes most often. Speed is worth less than the finding you cannot get anywhere else. |
| **Cons** | Slow on a large tree. Mitigated by `changedFilesArg` (lint only the diff, up to 60 files) and by the result cache. |
| **Cost** | 3-15s |
| **AI-friendliness** | Very high. The native JSON carries `fix`, which is ESLint's own statement that a change is mechanical - read directly into `safeToAutomate`. This is why the native format is parsed rather than the SARIF formatter, which drops it. |

## Type checking

| | |
|---|---|
| **Chosen** | `tsc --noEmit` |
| **Considered** | nothing serious |
| **Why** | There is no alternative that answers whether the program is well typed. A type error is the cheapest possible finding: always real, always local, never a matter of taste. |
| **Cost** | 3-20s |

## React performance

| | |
|---|---|
| **Chosen** | React Compiler ESLint rules + `react-hooks` rules (static), the runtime probe (dynamic) |
| **Considered** | React Scan, why-did-you-render, Million Lint |
| **Why** | React Scan (~50k weekly downloads) and why-did-you-render (~1.3M) are both **development-time overlays**. They need the app instrumented and a human watching; neither emits a machine-readable CI artifact. The React Compiler's lint plugin does the opposite: it reports statically, in ESLint's JSON, exactly the code it cannot memoize - which is the code that will re-render on every parent render. |
| **The honest gap** | Static rules find *risk*, not *occurrence*. They cannot tell you a component rendered 400 times. That is on the roadmap. |
| **AI-friendliness** | High for the static half: re-labelled into the `frontend-performance` category with an explanation of what the rule actually implies for rendering. |

## Accessibility

| | |
|---|---|
| **Chosen** | axe-core, driven by the runtime probe; Lighthouse's accessibility category as a second opinion |
| **Considered** | Pa11y, `eslint-plugin-jsx-a11y`, Lighthouse alone |
| **Why** | axe-core is the engine underneath nearly everything else in this space, including Lighthouse's own accessibility audits, and it analyzes the **rendered DOM**, which is where accessibility actually lives. `jsx-a11y` catches a real subset statically and is worth adding to the ESLint config; it cannot see a dynamically composed tree. Pa11y wraps axe with less control. |
| **Cost** | Included in the probe's runtime |
| **AI-friendliness** | Very high. Each violation carries `help`, `helpUrl` and the offending HTML. |

## Lighthouse / web vitals

| | |
|---|---|
| **Chosen** | Lighthouse CI (`@lhci/cli`) |
| **Considered** | WebPageTest, Unlighthouse, raw Lighthouse |
| **Why** | The reference implementation of "what does a browser think of this page", and the only tool here measuring Core Web Vitals the same way field data does. LHCI adds multi-run collection, which is what makes the numbers usable at all. |
| **Cons** | Noisy. Three runs and `main`-tier only, with an advisory budget - gating a pull request on a single Lighthouse run is how teams learn to ignore Lighthouse. |
| **Cost** | 60-180s |

## Bundle size

| | |
|---|---|
| **Chosen** | `scripts/cq/bundle-size.mjs`, emitting **size-limit's own output shape** |
| **Considered** | size-limit, bundlesize, Statoscope, rollup-plugin-visualizer, bundle-stats |
| **Why** | size-limit is the better tool and is the documented recommendation for a repository that wants per-entry budgets. It needs a config file, a bundler plugin and an install; the platform must produce a bundle number on a repository with none of those. So the script measures gzipped bytes per asset and emits size-limit's exact JSON, which means swapping in the real tool later is a **one-line manifest change and no normalizer change**. bundlesize is unmaintained. Statoscope is webpack-oriented. Visualizers produce treemaps, and a gate can only compare a number. |
| **Cost** | < 1s after the build |

## Visual regression

| | |
|---|---|
| **Chosen** | Playwright's built-in `toHaveScreenshot` |
| **Considered** | BackstopJS, Loki, Percy, Chromatic |
| **Why** | Playwright is already the e2e runner; its screenshot comparison needs no fourth tool, no service and no account. Percy and Chromatic are better products and are hosted and paid. BackstopJS is a separate stack for one feature. |
| **Cost** | Part of the Playwright run |

## End-to-end tests

| | |
|---|---|
| **Chosen** | Playwright |
| **Considered** | Cypress, Selenium, Puppeteer |
| **Why** | The only one of these shipping first-party JUnit output, first-party trace artifacts and built-in screenshot comparison. Cypress's architecture makes multi-tab and cross-origin work awkward; Selenium is heavier for less. |
| **Cost** | Minutes |
| **AI-friendliness** | High. JUnit failures normalize to findings with file, line and the assertion text. |

## Backend testing, races and leaks

| | |
|---|---|
| **Chosen** | `go test -race -json` |
| **Considered** | gotestsum (JUnit conversion), plain `go test` |
| **Why** | The **JSON stream, not a JUnit conversion**, because the highest-value Go signals - data races, deadlocks, goroutine leaks - arrive as *output text* on an otherwise ordinary failing test, and a JUnit conversion discards exactly that. The race detector is the single highest-value dynamic check available for a Go service, so it runs at `pr` rather than nightly: a race that reaches the default branch is already in production's future. |
| **Cost** | 2-10x the plain test time |
| **AI-friendliness** | Very high. A race becomes a `blocker` finding with the racing goroutines as evidence. |

`go.uber.org/goleak` is the recommended companion: add it to `TestMain` and its
"found unexpected goroutines" output is picked up as a goroutine-leak finding
with no further configuration.

## Benchmarking

| | |
|---|---|
| **Chosen** | `go test -bench` + `benchstat -format csv` |
| **Considered** | benchcmp (deprecated), hyperfine, a hand-rolled comparison |
| **Why** | **benchstat does the statistics.** It distinguishes a benchmark that got slower from one that was noisy, and a performance gate built on single runs cries wolf until somebody switches it off. Six runs, CSV out, one metric per benchmark, compared against the baseline. |
| **Cost** | Minutes. `main` and `nightly` only. |

## Load testing

| | |
|---|---|
| **Chosen** | k6 |
| **Considered** | Vegeta, Locust, JMeter, oha, wrk |
| **Why** | The test is a JavaScript file that **lives in the repository next to the code it exercises**, so the load profile is reviewable in the same pull request as the handler whose latency it measures. The summary is JSON by construction rather than by scraping. Vegeta is simpler and cannot express a scenario. JMeter is more capable and its artifact is an XML file nobody reviews. Locust needs a Python runtime. |
| **Cost** | 45s as configured |

## Profiling

| | |
|---|---|
| **Chosen** | `net/http/pprof` (in-tree), `go test -cpuprofile`/`-memprofile` |
| **Considered** | Parca, Pyroscope, py-spy equivalents |
| **Why** | pprof is in the standard library and needs nothing. Continuous profiling (Parca, Pyroscope) is genuinely valuable and is a *production* concern, not a CI gate - it belongs in the roadmap, not in the merge path. The CI-visible signal is benchstat's allocation and time-per-operation numbers. |

## Dead code

| | |
|---|---|
| **Chosen** | Knip |
| **Considered** | ts-prune, depcheck, unimported |
| **Why** | **ts-prune and depcheck were both archived in 2025.** Knip replaced them by answering unused *files*, unused *exports* and unused *dependencies* from a single module graph, with 150+ framework plugins. Generated code produces all three in quantity and nothing else in the toolchain notices any of them. |
| **Cost** | 5-20s |
| **AI-friendliness** | High, with `confidence: medium` - dynamic imports and framework entry points genuinely confuse it, which is why its budget ships advisory. |

## Duplicate code

| | |
|---|---|
| **Chosen** | jscpd |
| **Considered** | PMD CPD, simian, SonarQube |
| **Why** | Language-agnostic (it covers the Go and the TypeScript in one pass), token-based rather than line-based, JSON output, no service. CPD is JVM-hosted. Simian is not open source. |
| **Why it matters more now** | A model asked the same question twice produces the same block twice, in two files, with different variable names. This is the AI-era duplication that no reviewer catches. |
| **Cost** | 5-30s |

## Circular dependencies and architecture

| | |
|---|---|
| **Chosen** | dependency-cruiser |
| **Considered** | madge, eslint-plugin-import |
| **Why** | madge reports cycles. dependency-cruiser can state a **rule** about the graph ("nothing under `components` may import the API client directly"), which makes it an architecture gate rather than a metric. |
| **Cost** | 5-15s |

## Mutation testing

| | |
|---|---|
| **Chosen** | Gremlins (Go) |
| **Considered** | go-mutesting, StrykerJS (for the frontend) |
| **Why** | Mutation testing answers what coverage cannot: not "was this line executed" but "would any test have noticed if it were wrong". Gremlins is the maintained Go option. StrykerJS is the equivalent for TypeScript and is a good next addition. |
| **Cons** | Its own documentation says a run takes hours on a large module. Hence `nightly` only, advisory, and capped at 200 findings. |
| **Cost** | Minutes to hours |

## Security: SAST

| | |
|---|---|
| **Chosen** | Semgrep (community ruleset `p/ci`) |
| **Considered** | CodeQL, gosec, njsscan |
| **Why** | Covers the ground the language linters do not: cross-language taint patterns, injection shapes, unsafe deserialization. The community ruleset needs no account, no upload and no network dependency beyond fetching rules. CodeQL is more powerful and is effectively GitHub-only and much slower; it belongs in a scheduled workflow, not the merge path. gosec is subsumed by golangci-lint. |
| **Cost** | 30-120s |

## Security: dependencies

| | |
|---|---|
| **Chosen** | Trivy **and** OSV-Scanner **and** govulncheck |
| **Considered** | Grype, Snyk, Dependabot, `npm audit` |
| **Why three?** | They answer different questions, and where they overlap the deduplicator merges them and records the agreement. **Trivy** is the broad one: dependencies, misconfiguration, secrets and licences across Go, npm, Dockerfiles and Kubernetes in one binary. **OSV-Scanner** reads OSV.dev, which aggregates 20+ curated advisory sources with precise per-ecosystem version ranges, so it produces fewer false positives on lockfiles. **govulncheck** is the only one doing *reachability* analysis for Go: it reports a CVE only when the vulnerable symbol is actually called, which is the difference between a fixable list and a list nobody reads. |
| **Grype** | ~30-40% faster than Trivy at pure vulnerability scanning and better on Linux distro packages. Trivy wins here because breadth matters more than seconds when the database cache is warm, and neither is a pipeline bottleneck. Grype would be the right call for a container-image-first pipeline. |
| **Snyk / Dependabot** | Snyk is commercial. Dependabot is complementary (it opens PRs) rather than a gate. |
| **Cost** | 10-60s each, dominated by database refresh on a cold cache |

## Security: secrets

| | |
|---|---|
| **Chosen** | Gitleaks at the gate; TruffleHog recommended on a schedule |
| **Considered** | TruffleHog, detect-secrets, GitHub secret scanning |
| **Why** | These are complementary, not competing. **Gitleaks** is a regex scanner that finishes in milliseconds, which is the only thing that can honestly sit in a pre-commit hook. **TruffleHog**'s verifier modules validate 700+ secret types with safe read-only API calls, which is far better at proving a credential is *live* - and far too slow for a commit gate. The mature pattern is both: Gitleaks at the edge, TruffleHog scheduled over full history. |
| **Severity** | `blocker`, `alwaysRun`. A credential can be pasted into a Markdown file, so this is one of the two analyzers that ignore the diff entirely. |
| **The recommendation is not "remove it"** | It is "revoke it first". A secret that was pushed is a secret that leaked, whatever the diff says now. |

## SBOM

| | |
|---|---|
| **Chosen** | Syft, emitting CycloneDX JSON |
| **Considered** | SPDX (also via Syft), `cyclonedx-gomod`, Trivy's SBOM output |
| **Why CycloneDX** | It carries the component inventory, the vulnerabilities **and** the licences in one document, so a single artifact answers "what is in this build", "is any of it vulnerable" and "may we ship it". SPDX is the better licence-compliance archive and an ISO standard; Syft emits both and switching is one line. |
| **Licence policy** | The normalizer groups by licence rather than by package, because the decision ("may we ship AGPL code") is per licence. It surfaces the question; it does not decide policy. |

## Kubernetes and Helm

| | |
|---|---|
| **Chosen** | kubeconform (schema) + KubeLinter (policy) |
| **Considered** | kubeval, Polaris, kube-score, Datree, Checkov, `helm lint` |
| **Why** | **kubeval is unmaintained**; kubeconform replaced it with parallel validation, cached schema downloads, offline operation and CRD support. Where kubeconform asks "is this valid", KubeLinter asks "is this wise" - no resource limits, running as root, no readiness probe, a `latest` tag. Polaris answers the same question with a dashboard; KubeLinter answers it with SARIF, which a pipeline can consume. Datree was discontinued. |
| **Helm** | `helm lint` then `helm template | kubeconform` is the right chain when charts appear; the manifest is a one-file addition. |

## Docker

| | |
|---|---|
| **Chosen** | hadolint (lint) + Trivy (image scan) |
| **Considered** | dockle, docker scout, Snyk container |
| **Why** | hadolint parses the Dockerfile properly and embeds ShellCheck for the `RUN` lines, which is where the actual mistakes are. Trivy already covers image vulnerabilities and there is no reason to add a second scanner for it. |

## API contract

| | |
|---|---|
| **Chosen** | oasdiff (breaking changes) + Spectral (style) |
| **Considered** | openapi-diff, Schemathesis, Dredd, Pact |
| **Why** | They answer different questions and neither replaces the other. **oasdiff** knows ~500 distinct ways an OpenAPI change can break a consumer; a `git diff` of the JSON knows none of them. **Spectral** enforces spec quality (operation ids, descriptions, naming). |
| **Schemathesis** | Property-based testing of a *running* API against its spec - genuinely valuable and a good addition at the `main` tier, since it needs a live server. On the roadmap. |
| **Pact** | Consumer-driven contract testing. Right for a multi-service estate, over-engineering for one frontend and one backend that ship together. |

## OpenTelemetry

| | |
|---|---|
| **Chosen** | OTLP/JSON emitted directly, following the CI/CD semantic conventions |
| **Considered** | the OpenTelemetry Go SDK, Prometheus, structured logs |
| **Why** | See [ADR-0009](adr/0009-otel-without-sdk.md). Briefly: the SDK is a large transitive dependency tree on a binary that runs in a pre-commit hook and whose entire dependency list is one YAML parser - and every dependency is a supply-chain surface on the tool that reports supply-chain risk. |

---

## Summary: the recommended stack

```
formatting        gofmt, eslint
lint / static     golangci-lint (100+ linters), go vet, eslint, semgrep
types             tsc
tests             go test -race -json, playwright, (vitest)
coverage          go test -coverprofile, lcov
performance FE    lighthouse, size-limit shape, runtime probe
performance BE    benchstat, k6, pprof
dead / duplicate  knip, jscpd
architecture      dependency-cruiser
mutation          gremlins
security          trivy, osv-scanner, govulncheck, semgrep, gitleaks
supply chain      syft -> cyclonedx
infrastructure    hadolint, kubeconform, kube-linter, actionlint
api               oasdiff, spectral
observability     opentelemetry (otlp/json)
standards         sarif, junit, lcov, cobertura, cyclonedx, openapi, otlp
```
