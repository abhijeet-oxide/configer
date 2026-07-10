# Configer

Enterprise-grade configuration management platform that abstracts heterogeneous
configuration formats (YAML, JSON, XML, Helm values, Flux, kpt/KRM, …) into a
single structured parameter model, while **Git remains the source of truth**.

Configer scans a Git repository and presents a **spreadsheet view**: every
**row is a parameter**, every **column is an instance** (region / environment /
zone / site). Teams enrich parameters with metadata, set per-instance values,
bulk-edit, compare, and validate, and every change flows back to Git as
commits on branches, reviewed via pull requests, and published by merging.

![Dashboard](docs/screenshot-dashboard.png)
![Config Editor](docs/screenshot-light.png)
![Dark mode](docs/screenshot-dark.png)
![Validation enforcement in the cell editor](docs/screenshot-validation.png)

## Why

At scale you have hundreds of config files, tens of thousands of parameters,
replicated across many instances that may run different software versions.
Editing them by hand is error-prone and impossible to reason about in bulk.
Configer is the abstraction layer; Git stays native and canonical.

## What's in this repository

| Path | Description |
|------|-------------|
| `backend/` | Go API: parses the repo, resolves scope precedence, builds the grid, computes diffs, renders generated artifacts, and exposes everything over REST. |
| `frontend/` | React + Vite + TypeScript + **Ant Design** SPA: nav rail, category tree, virtualized parameter×instance grid, details panel, compare view, plugins view, light/dark/brand theming. |
| `sample-repo/` | A self-contained managed repository fixture (the `telco-platform` project) that the backend serves out of the box. |
| `deploy/` | `docker-compose.yml` for the self-hosted stack (backend + frontend + Postgres). |
| `.github/workflows/` | CI: Go vet/test/build + frontend typecheck/build. |

### How the abstraction maps to Git

```
sample-repo/
  base/                       # original/base config files (structure = truth)
  .configer/
    catalog.yaml              # the parameter model (id, name, path, type, validation, lifecycle)
    instances.yaml            # central instance registry (version / region / zone / env)
    scopes.yaml               # global / environment / site / zone overlays
    ignore.yaml               # selective-import rules (skip files / parameters)
    instances/<name>/overlay.yaml   # sparse per-instance value overrides
  generated/                  # rendered, ready-to-consume artifacts (git-native output)
```

**Scope precedence** (later wins): `default → global → environment → site → zone
→ instance`. Each grid cell shows the effective value plus a badge indicating
which scope supplied it.

**Version-aware cells:** a parameter carries `versionIntroduced` /
`versionDeprecated`; an instance carries `softwareVersion`. Cells render as
**new**, **deprecated** (disabled), or **not-applicable** accordingly.

### Typed editing & validation enforcement

Every parameter declares a **data type** (`string`, `integer`, `number`,
`boolean`, `enum`, `ipv4`, `cidr`) and **validation rules**: required, regex
pattern, min/max, character limits (`minLength`/`maxLength`), allowed values,
or a **predefined rule** from the built-in library (`ipv4`, `cidr`, `port`,
`hostname`, `fqdn`, `url`, `email`, `uuid`, `semver`, `duration`).

- The grid renders a **type-appropriate editor** per cell: a toggle for
  booleans, a number input that **clamps to min/max** for integers, a dropdown
for enums, and a text input with live regex/length feedback for strings;
  invalid entries cannot be committed.
- The **rule editor** (details panel → Schema tab) lets users pick a
  predefined rule from a dropdown or define custom rules; saved rules land in
  `catalog.yaml` and take effect immediately.
- The backend **re-validates every write** (type coercion + preset + explicit
  rules) and rejects invalid values with `422`, so Git never holds bad data.

### Structural divergence: lists, absence, and per-instance cardinality

Instances differ in *shape*, not just values: lab may carry 1 NTP server while
production carries 10. Verified renderer semantics (see
`backend/internal/render/render_test.go`):

| Scenario | YAML / JSON (incl. Helm values, Flux, kpt, which are YAML at rest) | XML |
|---|---|---|
| **List parameter** (`type: list`, `itemType: ipv4`, …) | native sequence: one line per entry, length per instance | repeated sibling elements: one `<server>…</server>` per entry |
| **Value unset / instance excluded** | key omitted entirely; empty parent maps pruned, **no line remains** | attribute/element removed; empty parent elements pruned, no husk like `<syslog/>` |
| **Unmanaged content in the base file** | passes through untouched | passes through untouched (incl. comments) |
| **User adds a parameter** (GUI → catalog) | appears only in instances where a value resolves | element/attr created on demand per instance |
| **User retires a parameter** (GUI) | removed from catalog + every overlay; regenerated files drop it everywhere | same |

Cell-level actions (right-click): **Edit value**, **Reset to inherited**
(remove the override, fall back to zone/site/env/global/default), **Exclude
from this instance** (render nothing, even if a default exists), and **Copy
value to…** other instances. All actions stage into the draft change request,
reviewable before anything touches Git.

### Git-native change requests

Cell edits never touch Git directly; they stage into a **draft change
request** (dashed-orange pending cells, auto-saved). Submitting the draft:

1. cuts branch `configer/cr-<n>` from the target in an **isolated worktree**,
2. writes the sparse overlays and re-renders `generated/` for the touched
   instances,
3. commits with the machine identity plus a `Changed-by: <user>` trailer,
4. pushes and, when the origin is GitHub and `GITHUB_TOKEN` is set, **opens a
   real pull request**,
5. tracks state: `Draft → Under Review → Approved → Published / Rejected`.

**Approve & Merge** in the UI performs the real merge (GitHub PR merge API, or
a `--no-ff` git merge in pure-git mode) and pushes the target branch. PRs
merged or closed directly on GitHub are detected and reflected back.

### Always live, never a blocker

A background sync loop (`CONFIGER_SYNC_SECONDS`, default 30) fetches origin and
fast-forwards the working tree, so **commits made directly on Git appear in the
grid automatically**: the header shows `git: live`. Everything Configer writes
is ordinary Git (branches, commits, PRs), so anything it does can also be done
directly on GitHub; if Configer is down, nothing is blocked.

### UI

- **Dashboard command center**: system health tile map, settings-by-category
  donut, 14-day change-activity sparkline, accent stat cards, recent activity
  in human sentences, and a Git education footer.
- **Virtualized** parameter×instance grid that auto-fits columns to the
available width: smooth with tens of thousands of rows; zebra rows,
  environment-tinted column headers, and a **group-overview strip** that fills
  leftover space when rows end early (no dead screen area).
- **Four responsive tiers**: phone (<576px: bottom tabs + read-only parameter
  cards with search), tablet (drawer-based panels), laptop (three-panel), and
  big monitors (proportional scaling).
- **Resizable panels** (tree / grid / compare / details) with persisted sizes;
  **View** menu for density, column visibility, and panel toggles; a
  **comfort text-size toggle** for easier reading.
- **Global search (⌘K)** matches names, descriptions, categories, source
  files/paths, and **values** across every instance.
- Light / dark / **company-brand theming** via design-token overrides; charts
  use a CVD-validated palette with legends (never color alone).

### Plugin architecture (everything is extensible)

The core is a plugin registry (`backend/internal/plugin`):

- **Ingest parsers**: YAML / JSON / XML (built-in), pluggable for more formats.
- **Transposers**: turn resolved config into arbitrary output artifacts. The
  built-in **Flux HelmRelease generator** synthesizes manifests that do *not*
  exist in the source repo. Add your own to emit any target shape into
  `generated/`.
- **Schema importers / validators / AI providers**: interfaces defined for
  JSON-Schema/YANG import, custom validation, and a plug-and-play AI module
  (intent → change request, chat across configs).

See [`docs/PLAN.md`](docs/PLAN.md) for the full design (RBAC & SSO, Git identity
modes with commit attribution, merge-conflict handling, Postgres grid cache,
drift detection, and the delivery phases).

## Run it locally

**Backend** (serves the sample repo):

```bash
cd backend
go test ./...
CONFIGER_REPO=../sample-repo go run ./cmd/configer   # listens on :8080
```

**Frontend**:

```bash
cd frontend
npm install
npm run dev                                           # http://localhost:5173 (proxies /api → :8080)
```

**Everything via Docker**:

```bash
cd deploy
docker compose up --build                             # frontend on :8088, backend on :8080
```

## API (MVP)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/grid` | Full parameter×instance matrix with cell states + validation. |
| GET | `/api/project` | Project name, instances, category tree, counts. |
| GET | `/api/parameters/{id}` | Parameter metadata. |
| GET | `/api/compare?left=&right=` | Semantic parameter-level diff between two instances. |
| GET | `/api/render/{instance}` | Rendered `generated/` artifacts (values + transposer output). |
| POST | `/api/scan` | Ingest scan: detect files, extract candidate parameters. |
| GET | `/api/plugins` | Registered plugin manifests. |
| GET | `/api/validation/presets` | The predefined validation rule library. |
| PUT | `/api/values` | Validated edit staged into the draft change request (422 on invalid). |
| DELETE | `/api/values?paramId=&instance=` | Revert one pending draft edit. |
| PUT | `/api/parameters/{id}` | Update a parameter's data type/validation rules (committed directly with attribution). |
| GET | `/api/changes` · `/api/changes/draft` · `/api/changes/{id}` | Change request list / current draft / detail (syncs PR state). |
| POST | `/api/changes/{id}/submit` | Draft → branch + commit + push + PR → Under Review. |
| POST | `/api/changes/{id}/merge` | Approve & merge (GitHub PR merge or local git merge) → Published. |
| POST | `/api/changes/{id}/reject` | Reject/close (draft: discard). |
| GET | `/api/repo/status` · POST `/api/repo/sync` | Git-liveness status / force a sync now. |

## Status

Working today: ingest → catalog → scope resolution → **editable grid with
typed, validation-enforced editors** → **draft → change request → branch →
commit → PR → publish** (git-native, with live sync of external commits and
PR-state reflection), plus the predefined rule library, rule editor, deep
search, resizable/responsive themeable UI, and the plugin architecture.
Next phases (docs/PLAN.md): webhooks + Postgres grid cache, param-level
conflict resolution UI, list/repeated parameters, import wizard, auth
(OIDC/SSO) + RBAC, schema import, secrets, and the AI module.
