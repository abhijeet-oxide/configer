# Configer API Architecture Review

A Principal-API-Architect review of the Configer backend HTTP surface, with a
concrete standard the team can hold every future endpoint to. It is written
against the API as it exists in `backend/internal/api` and reflects the changes
landed alongside it (code-generated OpenAPI, standardized error envelope).

Configer is unusual: it is **write-back-native GitOps**. The "database" is a
Git repository, most writes are asynchronous by nature (they become branches,
commits, and pull requests), and the platform layer is optional. The
recommendations below are tuned to that reality, not copied from a generic REST
checklist. Where a popular pattern would be over-engineering for this system, it
is called out as such.

---

## A. API Design Principles (mandatory)

Every endpoint, existing and future, must obey these. They are the shortest
possible set that keeps the surface consistent as it grows.

1. **URLs are resources, not actions.** Nouns in the path; the HTTP method is
   the verb. The only verbs allowed in a path are *state-machine transitions*
   that do not map to CRUD (`/changes/{id}/submit`, `/merge`, `/reject`), and
   those are always `POST` on a sub-resource.
2. **The contract is generated from the code.** OpenAPI is produced from handler
   annotations (`make docs`); CI fails if it drifts (`make docs-check`). A spec
   is never hand-written, so it can never lie.
3. **One error envelope, everywhere.** Every 4xx/5xx returns `APIError`
   (`code`, `error`, `requestId`, optional `fields`). Clients branch on `code`,
   never on prose.
4. **Validate first, then act.** Every write validates input and returns `422`
   with the offending field named before touching Git. This is already the norm
   (`validate.*` gates writes) and must stay the norm.
5. **The session identity always wins.** A write may carry an `author` body
   field, but when login is enabled the authenticated user overrides it
   (`api.author`). Never trust a client-supplied identity for attribution or
   authorization.
6. **Reads are safe; writes are attributed and audited.** `GET`/`HEAD` never
   mutate. Every mutating request lands in the audit trail with who/what/when.
7. **Plain language out.** User-facing `error` strings never contain git jargon,
   stack traces, tokens, or internal paths. The machine `code` carries the
   semantics; the string is for humans.
8. **Every response is correlatable.** `X-Request-ID` is set on every response
   and echoed into logs and the error body. Accept an inbound `X-Request-ID`.
9. **Versioned evolution is additive.** Add fields, never repurpose or remove
   them without a version bump. Unknown request fields are ignored, not fatal.

---

## B. Endpoint Inventory

Auth column: `session` = enforced only when OAuth is configured (single-user
deployments are open by design); `admin` = deployment admin; `approver` = the
approver role. Idempotency: whether a client can safely retry the identical
request. All routes also mount under `/api/repos/{repoId}/…`.

| Method | Route | Purpose | Sync/Async | Success | Auth | Idempotent | Notes |
|---|---|---|---|---|---|---|---|
| GET | `/api/health`,`/api/healthz` | Liveness | sync | 200 | none | yes | Does not check deps |
| GET | `/api/readyz` | Readiness | sync | 200/503 | none | yes | 503 until a repo serves |
| GET | `/api/meta` | Deployment identity | sync | 200 | none | yes | |
| GET | `/api/openapi.json`,`.yaml` | OpenAPI spec | sync | 200 | none | yes | Generated |
| GET | `/api/docs` | Swagger UI | sync | 200 | none | yes | Embedded, offline |
| GET | `/api/workspace`,`/api/repos` | Repo portfolio | sync | 200 | session | yes | |
| POST | `/api/repos` | Connect a repo | **async** | 202 | session | **yes** (by origin) | Background clone; poll status |
| PATCH | `/api/repos/{id}` | Rename application | sync | 200 | session | yes | |
| DELETE | `/api/repos/{id}` | Disconnect | sync | 200 | session | yes | |
| GET | `/api/repos/{id}/members` | Role assignments | sync | 200 | admin | yes | |
| PUT | `/api/repos/{id}/members` | Assign a role | sync | 200 | admin | yes | |
| DELETE | `/api/repos/{id}/members/{login}` | Clear a role | sync | 200 | admin | yes | |
| GET | `/api/audit`,`/api/audit/verify` | Audit trail | sync | 200 | admin | yes | |
| GET | `/api/auth/me` | Current identity | sync | 200 | none | yes | |
| GET | `/api/auth/login`,`/callback` | OAuth flow | sync | 302 | none | n/a | |
| POST | `/api/auth/logout` | End session | sync | 200 | session | yes | |
| GET | `/api/github/status`,`/repos`,`/branches` | Repo picker | sync | 200 | session | yes | Proxies GitHub |
| GET | `/api/fs/browse` | Local folder picker | sync | 200 | admin | yes | Localhost mode |
| POST | `/api/discover` | Onboarding proposal | sync | 200 | none | yes | Read-only |
| POST | `/api/init` | Initialize `.configer` | sync | 201 | session | **no** (409 guard) | One commit; Location |
| POST | `/api/deinit` | Remove `.configer` | sync | 200 | session | yes | |
| GET | `/api/application` · PUT | App identity | sync | 200 | session | yes (If-Match) | PUT: 412/428 |
| GET | `/api/project` | Project summary | sync | 200 | session | yes | |
| GET | `/api/grid` | Parameter x instance grid | sync | 200 | session | yes | |
| GET | `/api/instances` | Instance registry | sync | 200 | session | yes | |
| POST | `/api/instances` | Stage new instance | sync (stages) | 200 | session | **no** (409 guard) | Structural draft item |
| PUT | `/api/instances/{name}` | Stage metadata edit | sync (stages) | 200 | session | yes | |
| DELETE | `/api/instances/{name}` | Stage retirement | sync (stages) | 200 | session | yes | |
| GET | `/api/parameters/{id}` · `/history` | Parameter detail | sync | 200 | session | yes | |
| POST | `/api/parameters` | Create parameter | sync | 201 | session | **no** (409 guard) | Direct commit; Location |
| PUT | `/api/parameters/{id}` | Update parameter | sync | 200 | session | yes (If-Match) | Direct commit; 412/428 |
| DELETE | `/api/parameters/{id}` | Retire parameter | sync | 200 | session | yes | Direct commit |
| POST | `/api/parameters/retire-file` | Retire by file | sync | 200 | session | yes | |
| GET | `/api/compare` | Instance diff | sync | 200 | session | yes | |
| GET | `/api/render/{instance}` | Real files (draft-applied) | sync | 200 | session | yes | |
| PUT | `/api/values` | Stage value edit | sync (stages) | 200 | session | yes (upsert) | Validated |
| DELETE | `/api/values` | Revert pending edit | sync (stages) | 200 | session | yes | |
| PUT | `/api/files/draft` | Stage file edit | sync (stages) | 200 | session | yes | |
| GET | `/api/changes` · `/draft` · `/{id}` | Change requests | sync | 200 | session | yes | `{id}` refreshes PR |
| POST | `/api/changes/{id}/submit` | Draft -> branch+commit+PR | **async** | 202 | session | **no** (state guard) | Poll `state` |
| POST | `/api/changes/{id}/merge` | Publish | **async** | 202 | approver | **no** (state guard) | Poll `state` |
| POST | `/api/changes/{id}/reject` | Reject/close | sync | 200 | session | **no** (state guard) | |
| POST | `/api/changes/{id}/comments` | Add comment | sync | 200 | session | no | |
| PUT | `/api/changes/{id}/reviewers` | Set reviewers | sync | 200 | session | yes | |
| POST | `/api/scan` · `/api/import` | Scan / import settings | sync | 200 | session | scan: yes | |
| GET | `/api/repo/status` · POST `/sync` | Git liveness | sync | 200 | session | yes | |
| GET | `/api/repo/refs` · `/api/history` | Refs / commit log | sync | 200 | session | yes | |
| GET | `/api/repo/findings` · POST `/ack` | External-commit inbox | sync | 200 | session | yes | |
| GET | `/api/plugins` · `/api/validation/presets` | Capabilities | sync | 200 | none | yes | |

---

## C. Architecture Decisions (decide explicitly, do not inherit)

These are the choices that must be *made*, not defaulted into by the framework.
The recommended default is in **bold**.

1. **Spec source of truth:** hand-written vs generated. **Generated from code
   (swaggo).** Landed. A hand-written spec on a 60-endpoint surface was already
   drifting (it omitted ~20 live endpoints).
2. **OpenAPI dialect:** 2.0 (swaggo default) vs 3.1. **2.0 today**, because it is
   zero-friction with the existing `net/http` router and every tool consumes it.
   Migrate to 3.1 only when a consumer needs it (see D-8).
3. **Error shape:** ad-hoc `{error}` vs a typed envelope. **Typed `APIError`
   with a stable `code`.** Landed.
4. **Async model:** the change-request lifecycle *is* the async model. Submit and
   merge return the change resource whose `state` a client polls
   (`Draft -> UnderReview -> Approved -> Published`). **Keep this; do not bolt a
   second `/operations` API on top** (see D-3). A generic operations endpoint
   would be over-engineering: the CR is already the durable, pollable operation.
5. **Repository scoping:** unscoped `/api/...` (default repo) vs
   `/api/repos/{id}/...`. **Both, permanently** - the unscoped form is the
   single-repo/back-compat surface; document only one and note the prefix.
6. **AuthN vs AuthZ separation:** **enforced** - `authorize()` checks the
   authenticated user's *role on the specific repository*, not merely that they
   are logged in. This is correct and must not regress.
7. **Concurrency control:** last-write-wins vs optimistic. **Optimistic via
   ETag/If-Match on the direct-commit catalog writes** (see D-4). Draft edits are
   naturally conflict-tolerant (upsert into one draft); direct commits to the
   branch are not.
8. **Pagination:** unbounded vs bounded. **Bound every collection** (see D-1).
   Today `/grid`, `/changes`, and `/audit` can return unbounded arrays.
9. **Rate limiting / quotas:** none vs gateway. **Gateway/proxy responsibility,
   not app code** for per-IP limits; **app-level only for the expensive,
   GitHub-budget-spending endpoints** (`/github/*`, `/repos` connect). See D-6.
10. **Caching:** none vs conditional GET. **ETag + `Cache-Control: no-store` for
    the grid/render reads** (see D-7). Config data is user-specific; never let a
    shared cache hold it.

---

## D. Problems and Recommendations (ranked)

### Critical

**D-1. Collections are unbounded.**
`/api/grid`, `/api/changes`, `/api/audit`, `/api/instances` return whole arrays.
A large GitOps repo (thousands of parameters x dozens of instances) makes `/grid`
a multi-megabyte, slow, memory-heavy response, and there is no ceiling.
*Why it matters:* an unbounded response is a latency and OOM risk that only shows
up in production at scale.
*Fix:* adopt one pagination standard (section E). For `/changes` and `/audit`
(append-mostly, time-ordered) use **cursor pagination**; for `/grid` keep the
full matrix but add server-side `category`/`instance` filters and a hard
`maxRows` guard that returns `413`-style truncation metadata. Concretely:

```
GET /api/changes?limit=50&cursor=eyJpZCI6NDJ9
200 { "items": [...], "nextCursor": "eyJpZCI6MTd9", "hasMore": true }
```

**D-2. `POST /api/repos` (connect) is a long, non-idempotent, blocking clone.**
Cloning a large private repo can take tens of seconds; the HTTP request blocks on
it, and a client retry starts a *second* clone. It returns `200`, not `201`.
*Why it matters:* blocked requests time out behind proxies; duplicate submits
create divergent state; the wrong success code misleads clients.
*Fix:* model it as an async operation - return `202 Accepted` with the repo id
and a `status: connecting`, do the clone in the background, and let the client
poll `GET /api/repos/{id}` (its `error`/`needsSetup`/`syncError` already model
the states). Add **idempotency**: dedupe by origin (already done for the
*registered* case; extend it to in-flight connects) or accept an
`Idempotency-Key`. Until then, document it as non-retryable.

### High

**D-3. Success codes for creation and async acceptance are flattened to `200`.**
Creating a parameter/instance, initializing an app, and submitting a change all
return `200`. REST reserves `201 Created` (with a `Location`) for creation and
`202 Accepted` for "accepted, still processing."
*Why it matters:* clients and gateways use the status class for ret/cache/log
decisions; collapsing everything to `200` throws that signal away.
*Fix:* `POST /api/parameters` and `POST /api/instances` -> `201` +
`Location: /api/parameters/{id}`. `POST /api/changes/{id}/submit` and `/merge`
-> `202` (the work continues on the host). This is a *frontend-coordinated*
change (the client checks `res.ok`, so 2xx-to-2xx is low-risk) and should ship
with a one-line frontend update.

**D-4. No optimistic concurrency on direct-commit writes.**
`PUT /api/parameters/{id}`, `PUT /api/application`, and the instance metadata
writes commit straight onto the working branch. Two admins editing the same
parameter last-write-wins, silently.
*Why it matters:* lost updates on the catalog are silent data loss.
*Fix:* return an `ETag` (e.g. the file's blob SHA or the commit SHA) on the
`GET`, require `If-Match` on the `PUT`, and answer `412 Precondition Failed`
when it does not match. Draft-staged writes do not need this (they upsert into a
single owned draft).

**D-5. Downstream (GitHub/git) failures are not consistently classified.**
`/github/*` correctly returns `502` on upstream failure, but submit/merge map
*every* `changeset` error to `409 Conflict` - including a GitHub timeout or a
push rejection, which are `502`/`503`/`504`, not a client conflict.
*Why it matters:* a client cannot tell "you did something wrong" (retry is
pointless) from "GitHub was down" (retry with backoff is correct).
*Fix:* have `changeset` return typed errors (conflict vs upstream vs timeout)
and map them: state/precondition -> `409`, upstream 5xx -> `502`, deadline ->
`504`. The `APIError.code` then carries `conflict` vs `upstream_error`.

**D-6. No abuse protection on GitHub-budget-spending endpoints.**
`/api/repos` (connect) and `/api/github/*` spend the server's GitHub rate budget
and do real network/disk work. Nothing throttles them.
*Fix:* a small per-user token bucket on those specific routes returning `429`
with `Retry-After` and `RateLimit-*` headers. General per-IP limiting belongs at
the gateway, not in app code (do not build a global limiter).

### Medium

**D-7. Cacheable reads have no cache headers.**
`/grid`, `/render`, `/compare`, `/plugins`, `/validation/presets` are all read
paths. The static ones (`/plugins`, `/validation/presets`) are highly cacheable;
the user-specific ones must be explicitly `no-store`.
*Fix:* `Cache-Control: no-store` on user/config data; `ETag` + `304` on `/grid`
and `/render` (keyed by commit SHA + draft hash); `Cache-Control: public,
max-age=...` on `/plugins` and `/validation/presets`.

**D-8. Spec is OpenAPI 2.0.** Fine today, but 2.0 cannot express `oneOf`,
`nullable`, or multiple examples, which some of the polymorphic responses
(`value: any`, cell states) would benefit from.
*Fix:* revisit swaggo 3.1 output or a typed-handler framework only when a
consumer (client codegen, contract tests) actually needs 3.1. Not urgent.

**D-9. Error-envelope rollout is not yet 100%.**
The shared `writeErr` (all 500s) and every write path now emit `APIError`, but a
handful of read/hub error sites still return the bare `{error}` map.
*Fix:* finish migrating the remaining `writeJSON(w, status,
map[string]string{"error": ...})` sites to `writeError(...)`. Mechanical; tracked
in the checklist below.

**D-10. `202`-style progress/cancel/retention for change requests is implicit.**
Submit/merge are genuinely async but expose no explicit operation lifecycle
fields (progress, failure detail, expiry). The CR object carries most of this;
it is just not named as an operation contract.
*Fix:* document the CR `state` machine as the operation lifecycle (section F) and
ensure `merge` failures land a machine-readable reason on the CR, not just an
HTTP error that is lost on reload.

### Low

**D-11. `GET /api/history?limit=` silently clamps.** Out-of-range limits are
clamped rather than `400`-ed. Acceptable, but document the clamp in the param
description (done in annotations) so it is not surprising.

**D-12. Health vs readiness naming.** Three liveness aliases
(`/health`, `/healthz`) and one readiness (`/readyz`). Keep, but standardize new
probes on the `*z` spelling and document that health excludes dependencies.

**D-13. No request timeout on inbound handlers.** Long git operations can hold a
connection open indefinitely. Add a server `ReadHeaderTimeout`/handler timeout
(the async fix in D-2 removes the worst offender).

---

## E. Proposed API Standards (organization-wide)

### Routes
- Plural resource nouns: `/parameters`, `/instances`, `/changes`, `/repos`.
- IDs are opaque strings in the path; never leak storage details.
- Non-CRUD transitions are `POST /{collection}/{id}/{verb}` and nothing else.
- Max nesting depth 2 (`/repos/{id}/members/{login}` is the ceiling).

### Methods & semantics
- `GET`/`HEAD`: safe, idempotent, cacheable-by-policy.
- `PUT`: full-replace or idempotent upsert; safe to retry.
- `PATCH`: partial update (reserved; today PUTs act as partial - acceptable
  because the bodies are explicit patch shapes).
- `POST`: create or non-idempotent action; pair with `201`/`202` + idempotency
  where a duplicate is dangerous.
- `DELETE`: idempotent; deleting an absent resource is `404` only when the client
  needs to know, else `204`.

### Status codes
`200` read/replace ok · `201` created (+`Location`) · `202` accepted async ·
`204` no body · `400` malformed · `401` unauthenticated · `403` unauthorized ·
`404` absent · `409` resource-state conflict · `412` failed `If-Match` ·
`413` too large · `415` wrong media type · `422` validation ·
`429` rate limited (+`Retry-After`) · `500` unexpected · `502` upstream failed ·
`503` not ready · `504` upstream timeout.

### Error envelope (landed)
```json
{
  "error": "the value is not valid for this parameter",
  "code": "validation_failed",
  "requestId": "3f9a1c2b7e5d0a84",
  "fields": [{ "field": "value", "message": "must be between 1 and 65535" }]
}
```
`code` is a stable enum (`bad_request`, `unauthorized`, `forbidden`,
`not_found`, `conflict`, `validation_failed`, `payload_too_large`,
`unsupported_media`, `upstream_error`, `unavailable`, `internal_error`).

### Contracts
- JSON, `camelCase`, UTF-8. Timestamps RFC 3339 UTC (`2026-07-18T15:00:00Z`).
- Booleans are real booleans; enums are lowercase strings; empty collections are
  `[]`, never `null`. Absent optional fields are omitted, not `null`.
- No response envelope for resources (return the resource); collections use the
  paginated envelope below.

### Pagination (for large/growing collections)
```
GET /api/{collection}?limit=50&cursor=<opaque>&sort=-createdAt&<filters>
200 { "items": [...], "nextCursor": "<opaque|null>", "hasMore": true }
```
`limit` default 50, max 200. Cursor is opaque and stable. Offset pagination is
not used for append-heavy collections.

### Async operations
The change request is the operation. `submit`/`merge` return `202` + the CR;
clients poll `GET /api/changes/{id}` and read `state`
(`queued`≈Draft submitted, `running`≈UnderReview/merging, `succeeded`≈Published,
`failed`, `cancelled`≈Rejected). Failure detail lives on the CR, not only in the
HTTP error.

### Concurrency
`ETag` on catalog `GET`s; `If-Match` required on direct-commit `PUT`s; `412` on
mismatch. Draft edits are exempt.

### Security & observability (baseline, mostly landed)
Body size cap (`413`), request id on every response, structured access log,
panic recovery, CORS locked to an explicit origin, session cookies `HttpOnly` +
`Secure` in production, secrets never logged or returned. Add per-route rate
limits on GitHub-spending endpoints.

---

## F. Reference API Examples

**CRUD (create):**
```
POST /api/parameters
{ "param": { "name": "network.admin.port", "type": "integer",
             "validation": { "preset": "port" } } }
201 Created
Location: /api/parameters/net-admin-port
{ "id": "net-admin-port", "name": "network.admin.port", ... }
```

**Search / filter / sort:**
```
GET /api/changes?state=under_review&sort=-createdAt&limit=20
200 { "items": [ { "id": 42, "state": "UnderReview", ... } ],
      "nextCursor": "eyJpZCI6MjF9", "hasMore": true }
```

**Pagination (next page):**
```
GET /api/audit?limit=100&cursor=eyJpZCI6MTAwfQ
200 { "items": [...], "nextCursor": null, "hasMore": false }
```

**Async operation (submit + poll):**
```
POST /api/changes/7/submit   { "title": "Raise prod admin port" }
202 Accepted
{ "id": 7, "state": "UnderReview", "pr": { "number": 128, "url": "..." } }

GET /api/changes/7
200 { "id": 7, "state": "Published", "mergedAt": "2026-07-18T15:20:00Z" }
```

**Bulk operation (import - already partial-success shaped):**
```
POST /api/import
{ "parameters": [ {...}, {...} ], "ignoreFiles": ["Kptfile"] }
200 { "imported": 12, "skipped": ["already-managed-key"], "commit": "a1b2c3d" }
```

**Validation failure:**
```
PUT /api/values   { "paramId": "net-admin-port", "instance": "prod", "value": 99999 }
422 Unprocessable Content
{ "error": "the value is not valid for this parameter",
  "code": "validation_failed", "requestId": "3f9a...",
  "fields": [ { "field": "value", "message": "must be between 1 and 65535" } ] }
```

**Concurrency conflict (proposed):**
```
PUT /api/parameters/net-admin-port
If-Match: "sha-9f8e7d"
412 Precondition Failed
{ "error": "this parameter changed since you loaded it; reload and reapply",
  "code": "conflict", "requestId": "..." }
```

**Rate limiting (proposed for GitHub-spending routes):**
```
GET /api/github/repos
429 Too Many Requests
Retry-After: 12
RateLimit-Remaining: 0
{ "error": "too many requests; retry shortly", "code": "rate_limited",
  "requestId": "..." }
```

**Authentication / authorization failure (landed):**
```
POST /api/changes/7/merge
401 { "error": "sign in to use this deployment", "code": "unauthorized", ... }
403 { "error": "your role (editor) does not allow this action; it needs approver",
      "code": "forbidden", "requestId": "..." }
```

**Downstream service failure (proposed classification):**
```
POST /api/changes/7/merge
502 { "error": "GitHub could not be reached; the change was not published, retry shortly",
      "code": "upstream_error", "requestId": "..." }
```

---

## G. Production Readiness Checklist (use in PR + architecture review)

Contract & docs
- [ ] New/changed endpoint has full swaggo annotations; `make docs-check` passes.
- [ ] Path is a resource noun; any action verb is a `POST` sub-resource.
- [ ] Request/response shapes have named schemas or documented `object`.

Semantics
- [ ] Correct method (safe/idempotent as claimed).
- [ ] Correct success code (`200`/`201`+`Location`/`202`/`204`).
- [ ] Every failure path returns `APIError` with a stable `code` (finish D-9).
- [ ] Status codes distinguish authn (`401`) / authz (`403`) / validation
      (`422`) / conflict (`409`) / precondition (`412`) / upstream (`502/504`).

Validation & limits
- [ ] Body, query, and path inputs validated; offending field named in `fields`.
- [ ] Collection endpoints are bounded (pagination or hard cap).
- [ ] Body size is capped (inherited from `withBodyLimit`).

Concurrency & idempotency
- [ ] Direct-commit writes support `If-Match`/`ETag` (D-4).
- [ ] Non-idempotent creates are dedupable or documented non-retryable.

Security & authz
- [ ] Object-level authorization checks the user's role on *this* repo, not just
      that they are authenticated.
- [ ] No secrets/tokens/paths/stack traces in responses or logs.
- [ ] GitHub-budget-spending routes are rate-limited (D-6).

Observability & ops
- [ ] Request id on the response; structured log line emitted.
- [ ] Mutating action is audited (who/what/when).
- [ ] Async work exposes a pollable state with a machine-readable failure reason.
- [ ] Cacheable reads set `Cache-Control`/`ETag`; user data is `no-store` (D-7).

---

### What has been implemented

Round 1 (documentation + error contract):
- **Code-generated OpenAPI** (swaggo): every endpoint annotated, spec generated
  by `make docs` / `go generate`, embedded and served at `/api/openapi.json`,
  `/api/openapi.yaml`, and `/api/docs`. The hand-written `openapi.yaml` (which
  had already drifted) was removed.
- **CI drift guard** (`make docs-check`) so the spec can never fall behind code.
- **Standardized `APIError` envelope** (`code` + `requestId` + `fields`), adopted
  by the shared 500 path and every write endpoint.

Round 2 (Critical + High findings D-1 through D-5, all shipped):
- **D-1 Bounded collections.** `/changes` and `/audit` are now cursor-paginated
  (`{items, nextCursor, hasMore}`, `limit` default 50 / max 200); `/grid` carries
  a hard `maxGridRows` cap with `truncated`/`totalRows` metadata. No endpoint can
  stream an unbounded dataset.
- **D-2 Async connect.** `POST /api/repos` returns `202` immediately with a
  `status:"connecting"` summary and clones/opens in the background; the portfolio
  shows connecting/error states the client polls. Idempotent by origin
  (in-flight duplicates return `409` with the existing id).
- **D-3 Correct success codes.** `201 + Location` for created resources
  (`POST /parameters`, `POST /init`); `202 Accepted` for the async change-request
  transitions (`submit`, `merge`).
- **D-4 Optimistic concurrency.** Direct-commit catalog reads return an `ETag`
  (the catalog revision); `PUT /parameters/{id}` and `PUT /application` require
  `If-Match` and answer `428` (missing) or `412` (stale). Lost updates are
  prevented; the frontend tracks the revision transparently.
- **D-5 Typed downstream failures.** The change-request lifecycle distinguishes
  a client state-conflict (`409`) from a downstream GitHub/git failure (`502`,
  or `504` on timeout), so a client can tell "you did something wrong" from
  "GitHub was down".

Frontend reliability + auth foundation (see section H).

Remaining recommended follow-ups: D-6 (rate limiting on GitHub-spending routes),
D-7 (cache headers), D-8 (OpenAPI 3.1 when a consumer needs it), D-9 (finish the
error-envelope rollout on the last read/hub sites), D-10 through D-13.

---

## H. Frontend reliability, error handling & the auth foundation

This section answers the product questions directly: how the UI avoids showing
false status, how failures/timeouts/unknown responses are handled, and what
foundation makes adding OAuth/SSO providers a small change. The items marked
*(shipped)* are implemented; the rest are the ranked follow-ups.

### H.1 The single source of truth: a typed API client *(shipped)*

Every response now flows through one hardened client (`frontend/src/api.ts`):

- **No silent false success.** Only a 2xx resolves with data. Every non-2xx
  becomes a typed `ApiError` carrying `{status, code, message, requestId,
  retryAfter, fields}` parsed from the backend envelope, for both reads and
  writes (previously `GET` failures surfaced only a bare status line, and error
  bodies were parsed inconsistently). A component that receives data can trust it.
- **Timeouts.** Every request has a hard client-side timeout (`AbortController`,
  30s default). A hung request becomes a `TimeoutError` the user sees, never an
  infinite spinner.
- **Network vs timeout vs HTTP** are distinct types (`OfflineError`,
  `TimeoutError`, `ApiError`), so the UI can react appropriately (keep working
  from the offline snapshot vs offer a retry vs show the server's message).
- **Correlation.** The `requestId` is shown in the error toast so a user can
  quote it to support and it ties to the server access log.

### H.2 Global surfacing so nothing is swallowed *(shipped)*

- react-query is configured (`main.tsx`) with a **global query-error handler**
  that raises a theme-aware notification when a *first* load fails (a failed
  background refetch does not nag, since stale data is still shown).
- **Retry policy that respects status classes:** client errors (4xx) are never
  retried (they will not succeed); network/timeout/`429`/5xx are retried with
  exponential backoff. Mutations never auto-retry (a write may not be idempotent).
- A `notify.ts` bridge maps any thrown value to a plain-language title +
  description (never a raw stack), with tailored copy for 403 / 409-412 (reload)
  / 429 (retry-after) / 502-504 (downstream) / offline / timeout.

### H.3 Concurrency, async, and pagination wired end-to-end *(shipped)*

- **Optimistic concurrency (D-4):** the client transparently tracks the catalog
  revision from read `ETag`s and sends it as `If-Match` on catalog writes; a
  `412` surfaces as "this changed since you loaded it, reload" instead of a
  silent overwrite. No calling component changed.
- **Async connect (D-2):** the New Application flow starts the connection, then
  polls `waitForRepoReady(id)` until the background clone/open is ready or fails,
  so the wizard only advances on a real, ready repository.
- **Pagination (D-1):** the paginated `/changes` envelope is unwrapped in the
  client so the existing views keep their array contract; the `Page<T>` type is
  exported for future "load more" UI.

### H.4 Authentication foundation: provider-agnostic by construction *(shipped, extensible)*

The key design point for "OAuth tomorrow, any provider": **the frontend never
speaks a provider's protocol.** It only ever calls three backend routes:

- `GET /api/auth/me` -> `{enabled, user}` (is login configured, who am I),
- `GET /api/auth/login` -> a 302 into whatever the backend configured,
- `POST /api/auth/logout`.

Adding GitHub Enterprise, Microsoft/Entra, Okta, or any OIDC provider is a
**backend-only** change (a new `auth` provider + config); the UI needs no change
because it treats login as an opaque redirect and identity as `{login, name,
email, avatarUrl, admin}`. What shipped on top:

- A **graceful 401 handler**: any request that returns 401 dispatches an event
  that raises a dismissible "please sign in again" prompt with a Sign-in button
  (no abrupt redirect, no silent failure, no lost work).
- **Cookies sent with `credentials:"include"`** so the session works even when
  the SPA is served from a different origin than the API.

Recommended next steps to harden auth for multi-provider SSO (backend-led):
1. Generalize `internal/auth` to an interface with per-provider config
   (`authorize`/`token`/`userinfo` URLs, scopes), selected by
   `CONFIGER_AUTH_PROVIDER`. The cookie-session, CSRF-state, and role layers stay
   as-is. **Recommended default:** OIDC discovery (`/.well-known/openid-configuration`)
   so a new provider is pure config, not code.
2. Return the provider name and, if several are configured, a provider list from
   `/api/auth/me`, so the UI can render "Sign in with X / Y" from data (still no
   protocol knowledge in the client).
3. Keep authorization exactly where it is: server-side, per-repository role
   checks. The client must never gate on identity for security, only for
   affordances (hide a button), because the server already enforces it.

### H.5 Further frontend hardening (recommended, not yet shipped)

- **Surface the grid `truncated` flag** with a banner + a category/search filter
  prompt, so a very large repo degrades visibly rather than silently dropping
  rows. *(Medium)*
- **A React error boundary** around the app shell, so a render-time exception
  shows a recoverable error card (with the last `requestId`) instead of a blank
  screen. *(High, small)*
- **Idempotency keys** for the few non-idempotent creates once the backend
  accepts them (D-2 groundwork), so a double-submit from a flaky network cannot
  create duplicates. *(Medium)*
- **"Load more"/infinite scroll** on `/changes` and `/audit` using the exported
  `Page<T>` cursor, for deployments with long histories. *(Low)*
- **Optimistic UI with rollback** on value edits keyed to the draft, plus a
  visible reconcile on `412`. The draft model already makes this safe. *(Low)*
- **Centralize the API base** for the docs link and cross-origin deployments
  (today `/api/docs` assumes same origin). *(Low)*
