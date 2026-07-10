# Configer - Git-Native Configuration Management Platform: Detailed Plan

## Context

**Problem.** Teams that operate at scale (telco, platform, infra) manage hundreds of config
files: XML, JSON, YAML, Helm `values.yaml`, Flux/Kustomize, kpt/KRM packages, each with
thousands to tens of thousands of parameters, replicated across many deployment instances
(regions, environments, zones, sites) that may run different software versions. Editing these
by hand across files and branches is error-prone, hard to compare, and impossible to reason
about in bulk.

**Goal.** Build **Configer**, an abstraction layer (a "Configu-equivalent") that points at any
Git repository, scans it, and presents a **spreadsheet view**: each **row is a parameter**, each
**column is an instance**. Users import parameters from the source files, enrich them with
metadata (category, type, validation, secret flag, scope), set per-instance values, do bulk edits,
compare, and validate. Every change is written back as Git commits on branches, reviewed via pull
requests, and published by merging to target branches. **Git remains the single source of truth.**

**Decisions locked with user:**
- **Backend:** Go (speed + concurrency + go-git/KRM-native ecosystem).
- **Frontend:** React + Vite + TypeScript + **Ant Design 5** for the shell/tree/panels, with a
  dedicated virtualized grid on top.
- **Git provider:** GitHub-first behind a `PRProvider` interface (GitLab/Bitbucket later).
- **Deployment:** Self-hosted, single org, multi-tenant (tenants = teams/projects inside one org).

**Reference:** the provided "CLM" mockup: left category tree, center parameter×instance grid with
per-instance version headers, right Parameter Details panel, bottom Diff/JSON/YAML view, top nav
(Config Editor · Compare · Change Requests · History · Schemas · Validation · Deployments · Audit).

---

## 1. Core Model: how the abstraction maps to Git

Git is the source of truth. Configer stores three kinds of artifacts in the repo, plus a **metadata
DB that is only a cache/index** (rebuildable from Git at any time).

### 1.1 Repository layout Configer manages

```
<repo>/
  base/                          # original/base config files (structure = truth)
    values.yaml
    network.xml
    ...
  .configer/
    catalog.yaml                 # THE single parameter model (see 1.2)
    instances.yaml               # THE central instance registry / catalog (see 1.3)
    schemas/                     # imported JSON Schema / YANG-derived validation rules
      network.schema.json
    instances/
      prod-us-east/
        overlay.yaml             # SPARSE per-instance overrides only
      staging/
        overlay.yaml
  generated/                     # rendered, ready-to-consume configs (git-native output)
    prod-us-east/
      values.yaml                # base + overlays applied, comment-preserving
    staging/
      values.yaml
```

- **Overlays are sparse** (only params that differ from base/global) → minimal diffs → fewer merge
  conflicts and clean reviews.
- **`generated/`** is what downstream tools (Flux, Helm, kpt) actually consume, fully git-native.
- Adding an instance = append to `.configer/instances.yaml` + new `instances/<name>/overlay.yaml` +
  new column in the grid + new `generated/<name>/`.

### 1.2 The parameter catalog (single YAML the user described)

```yaml
apiVersion: configer.io/v1
kind: ParameterCatalog
metadata: { project: telco-platform }
parameters:
  - id: net-service-ip                 # stable machine ID
    name: network.service.ip           # human-given parameter name
    displayName: Service IP address
    category: Networking/IP Configuration
    type: string                       # string|integer|boolean|enum|ipv4|cidr|...
    scope: instance                    # global | environment | site | zone | instance
    secret: false
    source:
      file: base/values.yaml           # auto-detected file it comes from
      path: $.network.service.ip       # auto-detected: JSONPath (JSON/YAML) or XPath (XML)
      format: yaml
    validation:
      required: true
      pattern: '^(\d{1,3}\.){3}\d{1,3}$'
      schemaRef: schemas/network.schema.json#/.../ip   # optional link to imported schema
    default: 10.0.0.1
    versionIntroduced: v1.0.0
    versionDeprecated: null            # set when vendor deprecates
    dependsOn: [net-vip-enabled]
```

### 1.3 Central instance registry (`instances.yaml`) + per-instance overlay

`.configer/instances.yaml` is the **single catalog of all instances**: one place that answers
"which instance is at which software version, in which region/zone/environment/site, with what
labels." It is the authoritative index the grid columns are built from; adding a column appends here.

```yaml
apiVersion: configer.io/v1
kind: InstanceRegistry
metadata: { project: telco-platform }
instances:
  - name: prod-us-east
    environment: production
    region: us-east-1
    zone: us-east
    site: dc-1
    softwareVersion: v24.3.1
    labels: { tier: gold, tenant: acme }
    status: active                # active | draft | deprecated
  - name: staging
    environment: staging
    region: us-east-1
    zone: us-east
    softwareVersion: v24.3.1
    labels: { tier: silver }
```

Each instance's *values* live in its own sparse overlay (keyed by parameter ID):

```yaml
# instances/prod-us-east/overlay.yaml
kind: Overlay
values:
  net-service-ip: 10.10.10.10
  net-admin-port: 8443
```

Splitting registry (metadata) from overlays (values) means adding/retagging an instance or bumping
its version touches only `instances.yaml` (tiny, conflict-light), while value edits stay isolated per
instance. `instances.yaml` also drives version-aware cell state (§1.5) and grouping/filtering the
grid columns by environment/region/zone.

### 1.4 Scope precedence & the "effective value" shown in a cell

Resolution order (later wins): `default → global → environment → site → zone → instance`.
The grid cell shows the **effective** value; the overlay stores only where a level overrides.
A `source_scope` badge tells the user *why* a cell has its value (e.g. "from environment").

### 1.5 Per-instance software versions (introduce / deprecate)

Each instance has a `softwareVersion`; each parameter has `versionIntroduced`/`versionDeprecated`.
The grid computes per-cell state:
- instance version **<** `versionIntroduced` → **not applicable** (greyed/empty, non-editable),
- instance version **≥** `versionDeprecated` → **deprecated** (disabled cell),
- recently introduced (within N releases) → **highlighted** (new).

When a vendor drops new configs, re-scanning the new base version diffs the catalog and proposes
added/removed/changed parameters (a review step), setting `versionIntroduced/Deprecated`.

---

## 2. Backend architecture (Go)

Monorepo `configer/`. HTTP API via **Echo** (or Chi); internal services as packages.

| Package/Service | Responsibility | Key libs |
|---|---|---|
| `api` | REST (+ optional gRPC internal), auth middleware, tenant scoping | Echo, JWT |
| `gitengine` | Clone as **bare mirror cache**; **worktree per change request**; shell to `git` CLI for heavy clone/fetch, go-git for reads | go-git + `git` CLI |
| `ingest` | Detect config files (glob + content sniff), run parser plugins, emit candidate params | plugin registry |
| `parsers` | `Parser` interface + impls: JSON, YAML, XML, Helm values, Flux (Kustomize/HelmRelease), kpt/KRM | yaml.v3, beevik/etree |
| `schema` | Import JSON Schema & YANG → derive validation rules; validate values | santhosh-tekuri/jsonschema; pyang shell / goyang for YANG |
| `render` | Apply overlays→base→`generated/`, **comment/format preserving**, deterministic | yaml.v3 `Node`, etree |
| `diff` | Semantic **parameter-level** diff (instance↔instance, version↔version, branch↔branch) | internal |
| `catalog` | Read/write `catalog.yaml`; maintain param index | - |
| `changeset` | CR lifecycle: branch → write overlays+render → commit → push → PR | - |
| `provider` | `PRProvider` interface; **GitHub impl first** (open PR, status, reviews, merge), webhooks | go-github |
| `store` | Postgres access; the cache/index (see §4) | pgx + sqlc |
| `secrets` | Encrypt secret params before commit; never store plaintext | SOPS/age or Vault |
| `drift` | Reconcile Git ↔ cache; flag out-of-band edits (Git wins) | - |

**Performance principles:**
- **Bare mirror per repo** + shallow/partial fetch; **incremental parse** using `git diff <lastSHA>..HEAD`
  so only changed files are re-parsed.
- **Materialized grid cache** in Postgres (columnar-friendly) so the spreadsheet loads without
  re-parsing Git; refreshed by GitHub **push webhook** or periodic reconcile.
- Deterministic, pure renderer (golden tests) so re-renders never produce spurious diffs.
- Worker pool + context cancellation for parallel parsing across hundreds of files.

---

## 3. Change-request & Git workflow (states + conflicts)

**State machine:** `Draft → Under Review (PR open) → Approved → Published (merged)`; plus `Rejected`,
`Conflicted`. Mirrors the mockup's Change Requests / Deployments tabs.

1. **Edit (Draft).** Grid edits are auto-saved to the DB as pending `change_items` (NOT yet on Git).
   Undo/redo, bulk edit, live validation, and a preview diff are all pre-commit.
2. **Create Change Request.** Branch `configer/cr-<id>-<slug>` off the CR's target base (record
   `base_sha`); write updated sparse overlays + re-rendered `generated/`; commit; push; open PR via
   `PRProvider`. State → **Under Review**.
3. **Review.** On GitHub *or* in-UI (in-UI review calls GitHub API). Reviews/checks stream back via
   webhook and update state.
4. **Publish.** On approval + merge to target branch (`lab`/`production`/`main`/special) → state
   **Published**; cache re-synced from merged commit.

**Merge-conflict strategy (a top failure point): resolve at the parameter level, not raw text:**
- Because sparse overlays are keyed by parameter ID, two CRs touching *different* params never
  conflict even in the same file. Re-render is deterministic from overlays.
- Before opening/merging, **rebase the CR's overlays onto the latest target** and run a **3-way
  param-level merge**: conflict only when the *same* (param, instance) changed on both sides since
`base_sha`. Surface those few cells in a **conflict-resolution UI** (theirs / mine / edit); users
  never see Git text conflicts.
- **Optimistic locking** via `base_sha`; if the target moved, re-render + re-diff and prompt.
- **Presence indicators** ("Alice is editing prod-us-east") + soft advisory locks to reduce collisions.

---

## 4. Metadata database (deliberately light: Postgres)

DB stores **cache + operational state only**; **no config values are canonical here** (Git is).
It is fully rebuildable by re-scanning Git.

Tables: `tenants`, `users`, `memberships` (RBAC), `repositories`, `projects`, `instances` (env/zone/
site/version mirror), `parameters_cache`, `values_cache` (materialized grid: param×instance×branch →
effective value + source_scope), `change_requests`, `change_items`, `schemas_meta`, `drift_results`,
`audit_log`. Ephemeral presence/locks in Redis (optional) or a short-TTL table.

- **Multi-tenant isolation:** Postgres **Row-Level Security** keyed by `tenant_id`; every query is
  tenant-scoped; connection pooling via pgx.
- **Secrets:** for `secret: true` params, the DB stores only a ciphertext reference; plaintext lives
  encrypted in Git (SOPS/age) or in an external manager (Vault). UI masks; write path encrypts.

---

## 5. Frontend (React + Vite + TypeScript + Ant Design 5)

- **Shell/nav/tree/panels/forms:** Ant Design 5 (matches the dense, structured mockup with least
  custom work). Left **virtualized Tree** = parameter categories; right **Parameter Details** tabs
  (Details · Schema · History · Depends On).
- **The spreadsheet grid:** use **Glide Data Grid** (canvas-rendered, purpose-built for
spreadsheet-scale: handles both **row and column virtualization** for tens of thousands of params ×
  many instances). Alternative: AG Grid Community. This is the single most important perf choice.
- **Compare/Diff:** bottom panel, inline & side-by-side, "changes only" toggle; Monaco diff for raw
  file view, custom param-diff for the semantic table (as in mockup).
- **State:** TanStack Query (server cache) + Zustand (UI state); server-side pagination for the grid;
  `⌘K` parameter search; column groups by version header.
- **Bulk operations:** multi-cell/row/column select → set value, find-replace across instances,
  apply-to-all-in-scope, with **pre-commit diff preview**.
- **Cell states:** deprecated → disabled; newly introduced → highlighted; invalid → red with
  validation message; secret → masked; overridden vs inherited → badge.

---

## 6. Ingestion / scan flow (the onboarding wizard)

1. Point at repo + branch (GitHub App install for scoped tokens).
2. Mirror/clone; **detect** config files (globs + content sniff); user **selects which to import**.
3. Parser plugins extract candidate parameters: `file`, auto-detected `path`, inferred `type`, value.
4. Optionally attach **JSON Schema / YANG** → auto-populate validation rules into metadata.
5. User reviews candidates, edits metadata (name, category, scope, secret), and **selects** what to
   import.
6. Write `catalog.yaml` + seed instances (existing per-env files become initial instance columns).
7. Build the `values_cache` grid.

---

## 7. Points of failure & mitigations (explicitly requested)

**Usability**
- Huge grids → canvas virtualization (Glide), server pagination, lazy tree expansion, `⌘K` search.
- Accidental bulk edits → mandatory diff preview + undo/redo + dry-run render before commit.
- Merge conflicts confusing users → param-level conflict UI, never raw Git text.
- Messy source repos → guided import wizard with detection + explicit selection.

**Scalability**
- Large repos → bare mirror cache, shallow/partial fetch, incremental parse via `git diff`.
- Many params/instances → materialized columnar grid cache, indexed queries.
- Concurrency → optimistic `base_sha` locking + presence + param-level auto-merge.
- Many tenants → Postgres RLS + pooling; per-repo GitHub App tokens.

**Reliability / correctness**
- Git push / PR-provider outages → retry with backoff, idempotent CR branches, reconcile queue.
- Cache ↔ Git divergence → webhook + periodic reconcile; **Git always wins** (drift detection).
- Render must be deterministic → golden/property tests; comment-preserving writers.

**Security**
- Secrets never plaintext in DB; encrypted at rest in Git or external manager.
- RBAC per tenant/project: who may create CR, approve, merge to production.
- Full audit log; GitHub App (not PATs) for least-privilege, per-repo tokens.

---

## 8. Repository structure (new monorepo)

```
configer/
  backend/
    cmd/configer/main.go
    internal/{api,gitengine,ingest,parsers,schema,render,diff,catalog,changeset,provider,store,secrets,drift}
    migrations/                 # sqlc + goose SQL migrations
  frontend/
    src/{app,components,features/{grid,tree,compare,changerequests,schemas},api,store}
    vite.config.ts
  deploy/
    docker-compose.yml          # api + postgres + (redis) + frontend
    Dockerfile.{backend,frontend}
  docs/
  README.md
```

---

## 9. Phased delivery

- **Phase 0 - Foundations:** monorepo scaffold, Docker Compose (Go API + Postgres + Vite), GitHub App
  auth, tenant/RBAC skeleton, migrations.
- **Phase 1 - Ingest + Catalog (MVP read path):** YAML/JSON/XML parsers, scan wizard, `catalog.yaml`
  write, grid cache, read-only spreadsheet (Glide grid) + category tree + details panel.
- **Phase 2 - Edit + Change Requests:** cell edit, sparse overlays, deterministic renderer, CR
  branch→commit→push→**GitHub PR**, state machine, param-level diff/compare, validation engine.
- **Phase 3 - Scale & collaboration:** conflict resolution UI, presence/locks, incremental parse,
  webhook-driven cache refresh, drift detection, bulk edit, audit log.
- **Phase 4 - Advanced:** per-instance software versions (introduce/deprecate), schema import (JSON
  Schema + YANG), Helm/Flux/kpt parser plugins, secrets (SOPS/Vault), Deployments view.

---

## 10. Verification (how to test end-to-end)

- **Unit/golden:** parser plugins (round-trip parse→render preserves comments/formatting); renderer
  determinism (same overlays → byte-identical output); param-level 3-way merge cases; scope
  precedence resolution.
- **Integration (local):** `docker compose up`; point Configer at a seeded test repo (a `values.yaml`
  + `network.xml` with a few instances); run the scan wizard; confirm the grid renders the expected
  parameter×instance matrix and per-cell source_scope.
- **Workflow E2E:** edit a few cells → Create Change Request → assert a branch + PR appear on GitHub
  (via `mcp__github__pull_request_read`) with the expected sparse-overlay and `generated/` diff →
  approve/merge → assert state flips to **Published** and the cache re-syncs from the merged SHA.
- **Conflict E2E:** two CRs edit the same (param, instance); assert the conflict-resolution UI
  triggers and non-overlapping edits auto-merge.
- **Perf smoke:** synthetic catalog (~20k params × ~10 instances); assert grid scroll stays smooth
  (canvas virtualization) and grid API responses are paginated and fast.
- **Frontend:** use the pre-installed Chromium/Playwright to drive the scan wizard, grid edit, and
  compare views; screenshot against the mockup layout.

---

## 11. Plugin architecture (everything extensible) - ADDED

The system is built around a **plugin registry** so capabilities can be added without touching the
core. Four plugin kinds, each a Go interface with a `Manifest` (id, name, version, kind, config
schema) so plugins are discoverable and configurable from the UI:

1. **IngestParser**: reads a source file → extracts candidate parameters (path, type, value).
   Impls: YAML, JSON, XML, Helm values, Flux, kpt/KRM. Pluggable so new formats drop in.
2. **SchemaImporter**: reads a schema (JSON Schema, YANG) → emits validation rules onto params.
3. **Transposer / Generator**: the key new kind. Takes the resolved parameter set for an instance
   and **transposes it into arbitrary output artifacts** written to `generated/`. Example use case:
   a **Flux artifact generator** that synthesizes Flux/Kustomize/HelmRelease files that do **not
   exist in the source** but are produced from the config. A transposer declares which
   `generated/<instance>/...` paths it owns; the renderer delegates those paths to it. Config-driven
   (e.g. templates + parameter mapping) so users add new output shapes as plugins.
4. **Validator**: custom cross-parameter / policy validation (e.g. OPA/Rego, regex bundles).

`internal/plugin` defines the registry + interfaces; built-ins register at startup; external
plugins load via Go plugin descriptors / a plugin manifest per project
(`.configer/plugins.yaml`) so each project enables the plugins it needs.

## 12. AI module (plug-and-play, intent → config) - ADDED

- Every parameter already carries a **`description`** (in `catalog.yaml`): this is the grounding
  context the AI uses. Enrichment can auto-draft descriptions.
- A pluggable **AIProvider** interface (default: Claude via the Anthropic API; provider-agnostic so
  it can be swapped/disabled). Kept behind the plugin registry so it is truly optional.
- Capabilities: **chat across configurations** ("what differs between prod-us-east and dr?",
  "set all staging DNS to 8.8.4.4"), **intent → change request** (natural language → proposed cell
  edits shown as a diff the user approves before it becomes a CR), semantic search, and
  description/validation drafting. The AI only ever proposes; changes still flow through the normal
  CR → PR → publish pipeline.

## 13. Ignore rules (selective import) - ADDED

- **`.configer/ignore.yaml`** (or `.configerignore`): glob patterns for **files** to skip during
  scan, plus a list of **parameter paths/IDs** to ignore. The ingest wizard also lets users
  deselect files and parameters interactively; deselections persist into `ignore.yaml`.
- Ignored files never produce candidate params; ignored params never appear in the grid and are
  never written to overlays/generated output.

## 14. Auth, SSO & RBAC - ADDED

- **Login / identity:** pluggable auth via **OIDC/SAML**, including **Microsoft Entra ID (Azure AD)
  SSO** and any standard IdP; local accounts as fallback. Sessions via signed JWT.
- **User management:** invite/add users under the org; map IdP groups → Configer roles.
- **RBAC:** roles (e.g. Viewer, Editor, Reviewer, Approver, Admin) scoped per tenant/project.
  Enforced on every action: who may edit, create a CR, approve, and merge to protected branches
  (lab/production). Stored in `memberships` with row-level tenant scoping.

## 15. Git identity: two modes (ADDED)

1. **Per-user OAuth (act on behalf of user):** user authorizes via GitHub OAuth; commits/PRs are
   authored as that user with their own token. Cleanest attribution.
2. **Service account / machine identity:** a configured bot account + token (or GitHub App
   installation) performs all Git ops from the backend. Because every commit comes from one identity,
the **commit message must attribute the real author**: Configer appends a trailer, e.g.
   `Changed-by: Alice Wu <alice@corp>` (and Co-authored-by), and records the true user in the audit
   log and PR body. Mode is a per-repository setting.

## 16. Theming & design language - ADDED

- **Mature, modern aesthetic:** consistent icon set (Ant Design Icons / Lucide), tasteful color,
  clear density, subtle graphics. The mockup's polish is the bar.
- **Theme system:** light / dark / **custom company theme** via **YAML/JSON theme overrides**
(Ant Design `ConfigProvider` design tokens: primary color, radius, fonts). Users pick a theme or
  supply brand tokens; persisted per user and overridable per tenant. Layout is customizable
  (panel visibility, density, column pinning).

## 17. CI/CD - ADDED

- **GitHub Actions** workflows: `ci.yml` (Go build/test/lint + frontend build/typecheck on PRs) and
  `deploy.yml` (build & push backend/frontend container images, deploy). Configer's own repo and the
  managed config repos both benefit; the deploy pipeline ships the self-hosted stack.

## 18. Structural divergence between instances (list & repeated parameters) - ADDED

**Problem.** Instances differ not only in values but in *shape*: lab has one NTP source,
production has ten. A pure row-per-parameter grid cannot express per-instance cardinality.

**Three-tier design:**

1. **List-typed parameters**: `type: list<string>` (or `list<integer>`, `list<ipv4>`, …). The
   cell's value *is* the list; the cell editor becomes a **chips/tags editor** (add, remove,
   reorder inline). One grid row, naturally different lengths per instance; overlays store the
   whole list per instance. Validation gains `itemRules` (each element checked against
   pattern/preset) plus `minItems`/`maxItems`. This covers the NTP case with zero grid
   complexity and is the recommended default for simple value lists.

2. **Indexed parameter families**: for repeated *structured* blocks (`ntp[i].ip`, `ntp[i].port`,
   `ntp[i].keyId`), the catalog declares a **repeat group** with a path template
   (`$.ntp.servers[*]`). The grid renders a **group header row** showing per-instance entry
   counts ("lab: 1 · prod: 10") that expands into child rows per index; a cell whose index an
   instance doesn't define renders as *not present* with an inline **“+ add entry”** affordance
   that appends the sparse block only to that instance's overlay. Removing an entry tombstones it
   in that overlay.

3. **Copy affordances**: column-header menu: **"Copy values from ‹instance›…"** (whole column,
   a category subtree, or one repeat group); cell/group context menu: **“Copy to instances…”**
with a checklist. Every copy stages ordinary draft items; bulk structural changes remain
   reviewable in the change request before touching Git.

**Ingest detection.** The parsers already emit `[i]` indices when flattening; the scan folds
candidates identical up-to-index into a proposed *family* and asks the user (wizard step) whether
to model it as a list parameter or an indexed family.

## 19. Git-nativeness guarantees: liveness, conflicts, approvals, external changes - ADDED

**Core principle (non-negotiable):** everything Configer produces is plain Git: ordinary
branches (`configer/cr-N`), ordinary commits (machine committer + `Changed-by:` trailer),
ordinary PRs. Anything Configer can do can also be done directly on GitHub; if Configer is down
nothing is blocked, and when it returns it absorbs whatever happened while it was away.

- **Liveness (SHIPPED, Phase 2b):** a backend sync loop fetches origin every N seconds (default
  30, `CONFIGER_SYNC_SECONDS`) and fast-forwards the working tree when it is strictly behind, so
  **external commits appear in the grid automatically**; the header shows a live indicator
("git: live" / "N behind"). Phase 3 adds **GitHub push webhooks** for near-instant sync;
  same behavior, lower latency; polling remains the fallback.

- **Approvals both ways (SHIPPED, Phase 2b):** *In the UI*: Approve & Merge calls the real
GitHub PR merge API (indistinguishable from merging on GitHub). *On GitHub*: every CR shows
  its PR link; reviewers may approve/merge there instead, and Configer's refresh detects
  externally merged/closed PRs and flips the CR to Published/Rejected. Notifications can deep-link
  to either surface; the UI never forces a redirect, it embeds the PR link.

- **Merge conflicts:** every CR records `base_sha`. If the target advanced and the same overlay
  keys changed, the merge fails cleanly and the error is surfaced on the CR. Phase 3 completes
  the design: **parameter-level 3-way merge** (sparse overlays keyed by param ID make textual
conflicts rare); true conflicts render as a cell-level resolution UI (theirs / mine / edit);
users never see raw git conflict markers; plus a **"Rebase & resubmit"** action that re-cuts
  the branch from the new HEAD and replays the items.

- **Files added / deleted / changed outside Configer:** each sync that lands commits triggers an
  incremental reconcile (`git diff lastSHA..HEAD`, Phase 3):
  - **new config-looking file** → "Unmanaged changes" inbox: *"base/new-feature.yaml appeared,
    import 14 candidate parameters?”* (one click into the import wizard);
  - **deleted/renamed file** → affected parameters flagged `source missing` (grid badge +
    Validation tab); user re-points the source or retires the parameters via a catalog CR;
  - **edited managed file** → values are re-read automatically (already live today).

- **New version / folder drops:** when a vendor drops a new base version (folder, tag, or
  branch), scanning it diffs against the current catalog and proposes introduced/deprecated
parameters (setting `versionIntroduced`/`versionDeprecated`) as a **catalog change request**;
  reviewed and merged like any other change, with a “new version available” notification badge.
