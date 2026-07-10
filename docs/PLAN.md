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

## 0. Current Implementation Status (read this first, before exploring code)

This section is kept in sync with the actual codebase after every work session. Trust this over
memory of "what should exist" from the numbered design sections below, those describe the
target design; this section says what's real right now. Repo: `abhijeet-oxide/configer`,
branch `claude/config-management-system-nvrgou`. Backend `go build/vet/test` and frontend
`tsc --noEmit && vite build` are green as of the latest commit on that branch.

### Live end to end (built, wired, verified)

- **Ingest to catalog to grid**: `backend/internal/{ingest,parsers,project,grid,resolver}` scan
  YAML/JSON/XML, resolve scope precedence (default→global→env→site→zone→instance), and serve
  `GET /api/grid`. `frontend/src/components/ParameterGrid.tsx` renders it virtualized, with
  typed editors (string/int/number/bool/enum/**list**), live validation, cell-level actions
  (edit / reset-to-inherited / exclude / copy-to-instance via right-click menu), hover diff on
  pending cells, and a no-dead-space category summary strip when rows end early.
- **Validation**: `backend/internal/validate` (type coercion + a predefined rule library with
  human messages and examples, `presets.go`) enforced both client-side (blocks bad input) and
  server-side (`422` on write). Rule editor: `RuleEditor.tsx`.
- **Structural flexibility**: `type: list` parameters (chips editor, `ListEditor` in
  `ParameterGrid.tsx`) and instance-level exclusion tombstones. The renderer
  (`backend/internal/render/render.go`, tests in `render_test.go`) proves per-format semantics:
  YAML/JSON omit absent keys entirely (empty parents pruned), XML removes/repeats elements
  (no empty husks), verified for all three formats.
- **Change-request pipeline** (fully git-native): edits stage into a draft
  (`backend/internal/change`, `crstore`), `Submit` cuts an isolated worktree branch
  `configer/cr-<n>` (`backend/internal/changeset`, `gitengine`), commits with a
  `Changed-by:` attribution trailer, pushes, opens a real GitHub PR when `GITHUB_TOKEN` is set
  (`backend/internal/provider`). `Approve & Merge` calls the real GitHub merge API or a local
  `--no-ff` merge. State machine `Draft → Under Review → Approved → Published/Rejected`
  surfaces as `CrSteps.tsx` (a Steps tracker) and `StateTag`. Frontend views:
  `TopBar.tsx` (review-before-send modal: before/after table, per-row undo, jump-to-cell,
  production warning), `ChangeRequestsView.tsx`, `ApprovalsView.tsx` (approver inbox).
- **Git liveness both directions**: `backend/internal/api/sync.go` polls origin
  (`CONFIGER_SYNC_SECONDS`, default 30s), fast-forwards on external commits, detects a deleted
  upstream branch. `GET /api/repo/status` backs the "git: live / N behind" chip in `TopBar.tsx`
  and the status chip in `NavRail.tsx`.
- **Dashboard command center**: `DashboardView.tsx` + `charts.tsx` (dependency-free inline SVG,
  dataviz-skill-validated palette: health tiles, category donut, 14-day activity sparkline,
  diff mini-bar). Fills the viewport, no dead space.
- **Offline resilience**: `frontend/src/offline.ts`, edits queue locally when the backend is
  unreachable and replay on reconnect; grid/changes/meta snapshot to `localStorage` as a
  fallback render source; `App.tsx` shows a calm, deployment-aware "can't connect" state (uses
  `GET /api/meta` for name/version/environment) instead of dev-only text; state-aware skeletons
  per view (`Skeletons.tsx`) instead of a spinner.
- **UI shell**: responsive at 4 tiers (phone bottom-tabs + `MobileParamList.tsx` read-only cards,
  tablet drawers, laptop 3-panel, big-monitor scaling), resizable panels, light/dark/brand theming
  + comfort text-size toggle (`theme.ts`, `store.ts`), global search (⌘K), Phosphor icons via
  Iconify (`icons.tsx`, bundled, no runtime fetch). Zero em dashes anywhere in the codebase, keep
  it that way (use `:` `;` `,` or restructure the sentence instead).
- **Plugin architecture**: `backend/internal/plugin` registry; built-ins are the 3 parsers and
  the Flux HelmRelease transposer (`transposers/flux.go`, proves the "generate an artifact that
  doesn't exist in source" use case). `PluginsView.tsx` lists them.
- **Import wizard** (`ImportWizard.tsx`, nav key `"import"`): 3 steps over `POST /api/scan` and
  `POST /api/import`. Step 1 scans read-only and shows per-file new vs already-managed counts
  (matched by source `file|path` against the catalog); unticked files can persist into ignore
  rules. Step 2 is a selectable table with inline type/category/scope/secret editors, bulk-apply
  controls, category suggestions from the dotted name, and auto secret-marking for
  credential-looking names (values masked). Step 3 reviews with summary stats and explains the
  single Git commit before initializing. Indexed list entries from the parsers (`servers[0]`,
  `servers[1]`) are folded into one list candidate (`foldFile`), and a family whose list
  parameter is already managed counts as managed. The Repository Changes inbox can hand over a
  focus file via `importFocus` in `store.ts`: the wizard then auto-scans and preselects only
  that file/folder.
- **Repository Changes inbox** (`RepoChangesView.tsx`, nav key `"drift"`): cards per finding
  from `GET /api/repo/findings` with per-type icon/color, plain-word detail, affected-parameter
  chips that jump to the editor, and one-click actions: new file → "Import parameters" (jumps
  into the wizard with focus), deleted file → "Retire parameters" (`POST
  /api/parameters/retire-file` behind a Popconfirm), changed file → "View in editor", plus
  "Check now" and "Mark all as seen" (`POST /api/repo/findings/ack`). Findings self-resolve:
  the backend (`reconcile.go`) subtracts already-managed candidates from `new_file` counts and
  skips fully-imported files, and independently reports any managed source file missing from
  disk as `file_deleted` even when the ack..HEAD diff never shows a `D` (added and deleted
  within one unacknowledged window). Verified E2E in the browser: external commit → finding →
  focused import → finding resolves; external delete → retire → caught-up state.

### Not started at all (next work, suggested priority order)

0. DONE: the UX/bug feedback batch shipped. Editors commit on blur (the "edits revert" bug:
   blur used to cancel), Escape cancels, invalid input warns and never commits; dedicated Scope
   column (sortable, filterable) plus sorters on Parameter/Type; editing a global-scope value
   prompts "change for everyone / only this instance / cancel" and the everyone-path stages a
   scope-level item written to `.configer/scopes.yaml` on submit (`change.Item.Scope`,
   `writer.SetGlobalValue`); Details panel metadata is editable (description, display name,
   category, scope, secret) with source file/path locked; left pane has parameter leaves and a
   Systems tree that scroll-and-flash the grid row/column (`store.setJump`); content-aware
   column widths; local search inside the grid toolbar; CR reference id + category (commit
   trailers + PR body + tags in views). Verified E2E in the browser (14 checks).
1. **Remote-first multi-configuration workspace** (§21): phase R1 is DONE. The backend is now a
   workspace Hub (`internal/workspace` registry persisted in `CONFIGER_DATA/workspace.json`,
   `api.Hub` in `backend/internal/api/hub.go`): every repo-scoped endpoint is mounted under
   `/api/repos/{id}/...` (path-rewrite dispatch onto the unchanged per-repo `Server`), the
   legacy unscoped `/api/...` routes serve the first repository for compatibility, and
   `GET /api/workspace`, `POST /api/repos` (connect: git URL cloned via `gitengine.Clone` with
   optional token, local path opened in place), `DELETE /api/repos/{id}` manage the registry.
   `CONFIGER_REPO` now only seeds an empty workspace. Tokens are embedded in the server-side
   clone's origin (rediscovered on restart via `gitengine.TokenFromURL`) and redacted
   (`gitengine.Redact`) in every response and log. Each repo has its own crstore, sync loop
   (stoppable via `Server.StopSync`), findings ack and PR provider. Frontend: active repo in
   the store (`repoId`, persisted) routes the whole API client (`setApiRepo`/`rp` in `api.ts`);
   switching (`useSwitchRepo`) clears the query cache; offline snapshots are namespaced per
   repo. WorkspaceView is the portfolio dashboard (cards: project, branch, params, instances
   by environment, open CRs, sync health; connect modal; disconnect), the TopBar breadcrumb is
   a repo switcher, and the import wizard gained a "Connect repository" step 0 (pick a
   connected repo or connect a new one, then scan). Verified E2E in the browser with three
   repos (8 checks) plus the full 14-check feedback regression on the hub. NEXT here: R2, the
   `RepoBackend` interface + GitHub RemoteBackend (reads via contents/trees APIs, writes via
   the Git data API, no server-side clone), then cherry-pick / promote / upgrade-to-v2 (R3).
2. **Upstream data sources** (§20): vendored snapshots, bindings, sync-as-change-request
   (phases A/B).
3. Parameter-level 3-way merge / conflict-resolution UI (conflicts currently fail the merge
   cleanly but there's no resolver UI; "Rebase & resubmit" also missing), see §19. Note §20/§21
   both increase conflict frequency, design together.
4. Auth (OIDC/SSO, Microsoft Entra) + RBAC (roles designed in §14, nothing implemented).
5. GitHub push webhooks (sync is polling today, works but not instant).
6. Postgres grid cache (needed for real by the §21 workspace registry).
7. JSON-Schema/YANG schema import; secrets encryption at rest; the AI module
   (chat/intent-to-change-request); GitLab/Bitbucket providers; indexed parameter families
   beyond simple lists (§18 tier 2).

### Running it locally (for verification during development)

```bash
cd backend && go test ./... && CONFIGER_REPO=../sample-repo go run ./cmd/configer   # :8080
cd frontend && npm install && npm run dev                                            # :5173
```
`CONFIGER_REPO` seeds the workspace on first start; further repositories are connected from
the UI (Workspace screen or the import wizard) or `POST /api/repos`. Server state, including
clones of remotely connected repos, lives under `CONFIGER_DATA` (default `./configer-data`),
so delete that directory for a fully fresh workspace.
`sample-repo/` is a seeded fixture (`telco-platform` project) with 6 instances demonstrating
scope precedence, list parameters, and exclusion. For change-request E2E testing you need a real
git remote (a bare repo works): `git init --bare` + `git clone`, then point `CONFIGER_REPO` at
the clone, not `sample-repo/` directly (it has no remote, so submit/merge degrade to local-only
mode, which is still valid but doesn't exercise push/PR).

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

## 20. Upstream data sources (external values, vendored through review) - ADDED

**Use case.** Values often originate outside the managed repo: a platform team's shared config
repo (org-wide NTP/DNS/proxy), an IPAM/inventory export keyed by site, vendor release metadata,
Terraform outputs. Today someone copies them by hand and they rot. Configer should pull them in
programmatically, with full review.

**Core principle (non-negotiable).** Never read upstream live at render time; that would break
deterministic renders and the audit trail. Instead, **vendor a snapshot into Git through the
normal change request pipeline**: fetch upstream, evaluate mappings, and stage any differences as
an ordinary change request (before/after table, review, publish). The snapshot lives at
`.configer/sources/<id>/snapshot.yaml`, so renders never touch the network and upstream outages
block nothing. Every upstream-driven change carries a `Synced-from: <source>@<sha>` trailer.

**Source declarations** in `.configer/sources.yaml` (versioned, reviewable):

```yaml
sources:
  - id: platform-shared
    type: git                    # git | http | file; more via plugins
    repo: github.com/acme/platform-config
    ref: main                    # or a pinned tag/sha for strict determinism
    path: exports/network.yaml
    format: yaml
    auth: env:PLATFORM_REPO_TOKEN     # reference, never a literal
    refresh: { mode: manual }         # manual | interval | webhook
    policy: review                    # review | auto-publish (per target scope later)
```

**Bindings** connect upstream data to parameters, two shapes:
1. **Scalar binding**: parameter X at scope S takes its value from source Y at JSONPath P.
   Stored next to `validation`; the Details panel shows "Value comes from: platform-shared".
2. **Keyed binding** (the important one): upstream is a table keyed by site/instance. Declare a
   join: rows under `$.sites[*]` match instances where `instance.site == row.name`; map
   `row.syslog` to `net-syslog-collectors` at instance scope. A join between the instance
   registry and the upstream document; this is what makes 200 sites maintainable.

Selection via JSONPath (parsers already speak it), then type coercion + validation through the
existing `validate` package: a bad upstream value fails validation and becomes a finding, never a
silently broken render.

**Sync lifecycle** (reuses what exists): `POST /api/sources/{id}/sync` fetches, evaluates,
diffs. No changes: update "last checked". Changes: stage a CR "Sync from platform-shared
(a1b2c3d)" and surface an `upstream_change` finding in the Repository Changes inbox with
"Review & apply". Grid cells bound to a source get a provenance badge.

**Nuances**
- **Local override vs upstream**: per-binding policy `upstream-wins` | `local-wins` (pin, sync
  reports drift) | `manual` (every divergence is a review item). Default `manual`.
- **Upstream schema drift**: path gone or type changed → the binding fails loudly as a finding,
  last-good snapshot stays, never publish a hole.
- **Secrets**: never vendor plaintext; secret sources bind by reference (resolved at deploy),
  out of scope for v1.
- **Cycles/trust**: refuse a source that resolves to the managed repo itself; upstream content
  is untrusted input (validation + review gate it).
- **Determinism knob**: `ref: main` (convenient) vs pinned sha bumped via CR (strict); either
  way the snapshot records the exact resolved sha.
- **One-directional**: upstream is read-only input; the downstream direction is already covered
  by transposers. Mixing the two creates ownership ambiguity.

**Implementation phases**
- **A (backend core)**: `Source`/`Binding` in `model`; `sources.yaml` in `project`; new
  `internal/upstream` package with a `SourceProvider` plugin interface
  (`Fetch(ctx) (content, resolvedVersion, error)`) and built-ins git (reuse `gitengine`),
  http (ETag-aware), file (same-repo, trivial, great for tests); snapshot storage; binding
  evaluation; sync that stages a CR via the existing `changeset` service. Fourth plugin kind in
  the registry.
- **B (UI)**: Sources view (cards: last sync, resolved version, status, Sync now), binding
  editor in the Details panel, grid provenance badge, `upstream_change` finding with one-click
  review.
- **C**: interval/webhook refresh, per-scope auto-publish for trusted sources, provider plugins
  (S3, NetBox, Terraform state).

## 21. Remote-first, multi-configuration workspace (no local clone) - ADDED

**The intent (user's words):** a user owns and manages *multiple* configurations; they open the
app, pick a repository, connect, and edit. All changes are remote operations against the Git
provider (REST/GraphQL APIs): partial checkouts, partial commits, branch creation, PRs. Nothing
needs to be cloned to the server's disk as a prerequisite for a user to work. Advanced flows are
first-class: cherry-picking a change from one instance to another, and porting/carrying forward
changes from configuration version 1 onto a newly delivered version 2.

**What changes architecturally**

1. **Workspace model above projects.** Today the backend serves exactly one repo
   (`CONFIGER_REPO`). Introduce `Workspace → Repositories → Configurations`: a registry of
   connected repos (provider, owner/name, branch, auth installation id), each holding one or
   more Configer projects (a repo subpath with its own `.configer/`). All APIs gain a
   `{repoId}` scope: `/api/repos`, `/api/repos/{id}/grid`, etc. The UI gets a repository
   switcher (top bar) and a "Connect repository" step folded into the import wizard: pick
   provider → pick repo/branch (via provider API) → scan → import (the wizard's steps 1-3
   as they exist today).

2. **RepoBackend abstraction: local engine vs remote API engine.** Define one interface the
   rest of the backend already implicitly uses:
   `ReadFile/ListTree/Commit(files, message, branch)/CreateBranch/Diff/Merge/PR ops`.
   - **RemoteBackend (new, default for connected repos)**: GitHub first. Reads via the
     contents/trees APIs (partial checkout: fetch only `.configer/**`, `base/**` and the files
     bound to parameters, never the whole repo); writes via the Git data API (create blobs →
     tree → commit → update ref), which gives atomic multi-file "partial commits" without any
     working tree. PRs/merges via the existing `provider` package. A small content-addressed
     cache (sha → blob) keeps it fast and cheap; ETags/conditional requests respect rate limits.
   - **LocalBackend (kept)**: the current gitengine/worktree path; still ideal for self-hosted
     air-gapped mode, for the renderer's golden tests, and as the fallback when a provider
     lacks APIs. The renderer, resolver, validate, change pipeline all stay backend-agnostic;
     only gitengine call sites move behind the interface.
   - Rate-limit reality: remote mode batches reads (trees API with `recursive=1`, then selective
     blobs) and keeps the materialized grid cache (§4) as the thing the UI reads, refreshed by
     webhooks; the provider API is not hit per user interaction.

3. **Cross-instance and cross-version change operations** (all built on the same primitive:
   *a change set = a list of (parameter, scope/instance, action, value) items*, which is
   already the CR item model):
   - **Cherry-pick between instances**: select cells or a whole column diff (Compare view
     already computes it), choose "Apply these to <instance>", stage as a draft CR. This is a
     semantic cherry-pick (by parameter identity, not git commit), so it survives file layout
     differences. The existing copy-to-instance context action is the single-cell version;
     this generalizes it to diff-driven bulk.
   - **Cherry-pick between branches/CRs (git-level)**: for published commits, offer real
     `cherry-pick` semantics: remote mode replays the commit's overlay diff onto a new branch
     via the Git data API; local mode shells to `git cherry-pick`. Conflicts fall into the
     param-level conflict UI (§19), never raw markers.
   - **Version-to-version carry-forward**: when v2 lands (new folder/branch/tag), compute
     three lists: params unchanged (auto-carry), params whose *defaults* changed in v2 but were
     locally overridden (review each: keep my override / take vendor's new default), params
     gone/new in v2 (retire/import, already built). Present as a guided "Upgrade to v2" wizard
     producing one reviewable CR. This is the §1.5/§19 version-drop story matured into a
     migration flow.
   - **Promote between environments**: same mechanics as instance cherry-pick but
     scope-to-scope (staging → production), with the production warning + approval gates.

4. **Dashboard matures into a portfolio view.** Home shows all connected repositories →
   configurations → instances as a drillable hierarchy: per-config health (validation
   failures, drift findings, open CRs, behind/ahead vs remote), recent activity across all
   repos, and attention items ("prod-us-east has 2 findings", "v2 available for telco-core").
   The current single-config dashboard becomes the drill-in level. Multi-config also means
   per-repo state isolation (each repo gets its own crstore/state, sync loop, findings ack).

5. **Sessions/tenancy implications**: connected-repo credentials come from the GitHub App
   installation (per-repo tokens, least privilege, §15 mode 2) or the user's OAuth (mode 1);
   the workspace registry is the first thing that genuinely needs the Postgres layer (§4),
   since it is server state, not repo state.

**Phasing (deliberately incremental, nothing big-bang)**
- **R1 (SHIPPED)**: multi-repo registry + repo switcher with the *existing local engine*
  (server manages N clones instead of 1; `CONFIGER_REPO` becomes a seed). Import wizard gains
  the "Connect repository" step. Dashboard portfolio level (WorkspaceView). See §0 item 1 for
  the implementation map.
- **R2**: `RepoBackend` interface + RemoteBackend for GitHub (reads first, then Git-data-API
  commits); clones become an optional cache, not a requirement.
- **R3**: cherry-pick (semantic + git-level), promote, and the "Upgrade to v2" carry-forward
  wizard on top of the diff/CR primitives.
