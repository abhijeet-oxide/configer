# Backend / Platform Tech Notes

How Configer's backend is wired today, what shipped in the DX/observability
pass, direct answers to the "do we need library X?" questions, and the
recommended (modern) path for the things that are still gaps.

---

## 1. What shipped in this pass

| Area | What | How to use |
|------|------|-----------|
| **Run locally** | One command runs both servers | `make dev` (or `task dev`) → backend `:8080` + app `:5173`, Ctrl-C stops both. `make help` lists all targets. |
| **Config** | Typed `internal/config` centralizes every env var with defaults + validation | See `.env.example`; read via `config.Load()`. |
| **Feature flags** | `CONFIGER_FLAG_<NAME>=true` → `cfg.Flags.Enabled("name")` | Env-driven; logged at startup. |
| **Structured logging** | `log/slog`, text for dev / JSON for prod | `CONFIGER_LOG_FORMAT=json`, `CONFIGER_LOG_LEVEL=debug`. `slog.SetDefault` also routes existing `log.Printf` calls, so the whole app is structured. |
| **Request observability** | Middleware: `X-Request-ID`, one access-log line/request (method/path/status/bytes/duration), panic recovery | Automatic on every route. |
| **Health** | `/api/healthz` (liveness), `/api/readyz` (503 until a repo serves) | Wire container/k8s probes to these. |
| **API docs** | OpenAPI 3.0 spec, embedded, + **offline** Swagger UI | Spec: `GET /api/openapi.yaml`; UI: `GET /api/docs`. Edit `backend/internal/api/openapi.yaml`. |
| **API base URL** | Configurable for dev + built SPA | `VITE_API_PROXY_TARGET` (dev proxy); runtime `window.__CONFIGER__.apiBaseUrl` via `public/config.js` (no rebuild) → `VITE_API_BASE_URL` → same-origin `/api`. |
| **Graceful shutdown** | Drains in-flight requests on SIGINT/SIGTERM | Clean rollouts, no truncated responses. |

---

## 2. "What are these libs and do we need them?"

Short answer: **none of them are in the project, and none are needed right now.**
The backend has exactly two dependencies (`beevik/etree` for XML, `yaml.v3`) plus
the tiny Swagger-UI embed added this pass. Most of the libraries you listed only
become relevant once the **Postgres phase** (the grid cache in `docs/PLAN.md`)
actually lands — and today there is no database in use at all.

| Library | What it's for | Verdict for Configer |
|---------|---------------|----------------------|
| **chi-router** | HTTP router/middleware | **Skip.** Go 1.22+ `net/http.ServeMux` already does method + path-pattern routing (`GET /api/repos/{id}`), which is exactly what we use. Adding chi would be a lateral move with a new dependency. Revisit only if we need chi's middleware ecosystem or sub-routers, and even then `alice`-style chaining on stdlib is enough. |
| **zap** | Structured logging | **Skip.** We adopted stdlib `log/slog` (Go 1.21+), which is structured, fast enough, zero-dependency, and now the ecosystem default. zap/zerolog only pay off at extreme log volumes we're nowhere near. |
| **sqlc** | Type-safe Go from SQL | **Not yet — but the right choice when the DB lands.** When the Postgres grid cache is built, sqlc (compile SQL → typed Go) is preferable to a heavy ORM: no runtime reflection, SQL stays explicit and reviewable, great for a read-cache workload. |
| **go-migrate** | DB schema migrations | **Not yet — needed with the DB.** When Postgres is introduced, use versioned migrations. `golang-migrate` or `goose` are both fine; `goose` is a touch simpler to embed. |
| **ent / bun** (ORM) | Object-relational mapping | **Skip / avoid.** For a cache-shaped Postgres workload, an ORM adds magic and coupling we don't want. Prefer `sqlc` + plain `database/sql`/`pgx`. Consider an ORM only if the schema grows into a rich relational domain, which the current design doesn't call for. |

**Rule of thumb going forward:** add a dependency when it removes real risk or
a lot of code, not by default. The one dep added this pass (embedded Swagger UI)
earns its place by delivering a requested, offline-capable feature that would be
a lot of hand-rolled asset-embedding otherwise.

---

## 3. Observability — where to go next

Shipped now: structured logs + request IDs + access logs + panic recovery +
health/readiness. That covers **logs** and basic request visibility. The two
gaps are **metrics** and **traces**. Recommended, modern path:

1. **Metrics — Prometheus.** Add `prometheus/client_golang`, expose `/api/metrics`,
   and record: request count/latency histograms (by route + status), sync-loop
   duration and failures, in-flight requests, and change-request state
   transitions. This is the single highest-value next step for production ops.
2. **Traces + unified pipeline — OpenTelemetry.** Wrap the HTTP handler with
   `otelhttp`, propagate context into the git/provider calls, and export OTLP to
   a collector (Tempo/Jaeger/Datadog/Honeycomb). OTel can carry metrics and logs
   too, so it's the "one pipeline" option if you'd rather not run Prometheus
   directly. Our existing `X-Request-ID` should become / ride alongside the trace
   id for correlation.
3. **Dashboards + alerts.** Grafana on Prometheus/Tempo; alert on readiness
   flaps, 5xx rate, and sync-loop errors.

Keep the current slog access log — with OTel it becomes trace-correlated logging.

---

## 4. Feature flags — where to go next

Shipped now: env-driven booleans (`CONFIGER_FLAG_*`), good for static
per-deployment toggles. When you need runtime toggles, targeting (per org/user),
gradual rollout, or a UI:

- **Adopt [OpenFeature](https://openfeature.dev)** (the CNCF vendor-neutral
  standard). Keep `cfg.Flags` as the local/bootstrap provider and add a
  hosted/self-hosted provider (flagd, Unleash, LaunchDarkly, GrowthBook) behind
  the same interface, so call sites don't change.
- Expose a `GET /api/flags` endpoint so the **frontend** can gate UI the same
  way (today flags are backend-only).

---

## 5. Config & secrets — where to go next

Shipped now: one typed `internal/config` with defaults, validation, and
secret-redacted logging; `.env.example` documents everything.

- **Loader:** stdlib is fine at this size. Reach for `koanf` or `viper` only if
  you need layered sources (file + env + flags) or hot-reload — don't add them
  preemptively.
- **Secrets:** `GITHUB_TOKEN` is read from env and never logged or sent to the
  browser. For production, source secrets from a manager (Vault, AWS/GCP secret
  manager, k8s Secrets) rather than plain env, and support per-repository tokens
  (already modeled on the workspace entry).
- **Validation:** consider failing fast on obviously-bad config (e.g. malformed
  `CONFIGER_ADDR`) at startup.

---

## 6. Other improvements worth doing (prioritized)

1. **Backend HTTP tests.** The handlers have no tests yet; add table-driven tests
   against `hub.Routes()` with `httptest`, and contract-test responses against
   `openapi.yaml` so docs can't drift.
2. **CI.** The workflow builds/vets; add `make test`, `go test -race`, and a
   frontend `tsc` gate on PRs. Wire the Docker healthcheck to `/api/readyz`.
3. **Request timeouts & limits.** Add server `ReadTimeout`/`WriteTimeout`, a body
   size limit, and a per-IP rate limit on mutating routes.
4. **Consistent error envelope.** Standardize on `{ "error": { "code", "message" } }`
   and machine-readable codes, reflected in the OpenAPI schemas.
5. **AuthN/AuthZ.** OIDC/SSO + RBAC is on the roadmap; the account-menu shell and
   `Changed-by` attribution already anticipate it. Put it behind the API before
   multi-tenant use.
6. **API versioning.** Introduce `/api/v1` before external consumers depend on
   the surface, so future changes don't break them.
7. **Frontend bundle.** Code-split the Monaco editor (currently a ~3 MB chunk)
   with a dynamic import so the initial load stays small.
