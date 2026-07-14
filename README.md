# Configer

**A UI for GitOps configuration — where your files stay the truth.**

Configer connects to an existing Git repository (kpt/KRM packages, Kustomize
base+overlays, plain per-instance folders of YAML/JSON/XML), discovers its
structure, and presents configuration as a **spreadsheet**: every **row is a
parameter**, every **column is an instance** (environment / region / site),
every cell the value for that instance.

The pivotal property is that Configer is **write-back-native**:

- Your repository's own files are the single source of truth. Nothing is
  generated, nothing is copied, no parallel value store exists.
- Editing a cell surgically edits the real file — comments, ordering and
  unmanaged content preserved byte-for-byte. The diff is exactly what a
  careful engineer would have written by hand.
- Everything the UI does is an ordinary Git operation: edits stage into a
  draft, submitting cuts a branch + commit (+ a real GitHub PR), approving
  merges. If Configer is down, nothing is blocked — and commits made
  directly on Git flow back into the grid automatically.
- Configer's own footprint is one folder of **metadata only**:

```
.configer/
  application.yaml   name, description, detected layout
  parameters.yaml    parameter metadata: type, category, description,
                     validation rules, lifecycle versions, and BINDINGS —
                     the real-file locations each parameter lives at
  instances.yaml     instance metadata: folder binding, environment, region,
                     software version, labels, status
  ignore.yaml        scan exclusions
```

## What it does

**Onboarding** — point Configer at a repo and it proposes an application:
the layout adapter detects the convention (kpt package variants, Kustomize
overlays, or per-instance folders), derives the instances from the folder
structure, extracts every candidate parameter, and **deduplicates** the same
logical setting across files and instances — a `namespace` repeated in ten
files becomes ONE row bound to ten locations. Initialization is a single
reviewable commit adding `.configer/`; anyone else opening the repository
sees the same application from then on.

**The grid** — a virtualized parameter×instance matrix with typed cell
editors (numbers clamp to min/max, enums are dropdowns, booleans toggle,
lists edit natively), per-cell provenance badges (own file / shared base
file / declared default, with the exact file and path), and version-aware
cells (`new` / `deprecated` / `n/a`) driven by each instance's software
version. Editing a deduplicated parameter fans out to every bound file.

**Validation, enforced** — rules come from JSON Schema files found next to
the config (`values.schema.json`, `<file>.schema.json`,
`.configer/schemas/`), from a built-in preset library (ipv4, cidr, port,
fqdn, url, email, uuid, semver, …), or typed in by hand. The backend
re-validates every write and rejects invalid values with `422` — in the grid
AND in file mode — so Git never holds bad data.

**File mode** — a VS Code-like editor over the instance's real files:
file tree with modified markers, a live side-by-side Monaco diff of
committed vs draft-applied content, and full editing. Saving stages into
the SAME draft as grid edits: changes to managed values become validated
cell edits (the grid updates instantly), anything else stages as a file
edit. Grid and files are two views of one draft.

**Instances as reviewed changes** — creating an instance stages a
structural change: on submit, the branch carries a scaffolded folder
following the repository's own convention (a Kustomize overlay copy with
self-references renamed, a kpt package copy with its Kptfile renamed, a
plain folder copy) plus the registry entry. The grid previews the new
column immediately; it publishes when the change merges. Retiring works
the same way, in reverse.

**Change requests** — drafts accumulate edits (cells, file edits, instance
changes) shown in a Source Control panel grouped by file with one-click
undo. Submit = branch `configer/cr-<n>` + one attributed commit + GitHub PR
when configured; the state machine (`Draft → Under Review → Approved →
Published / Rejected`) reflects PR activity both ways.

**Compare** — semantic parameter-level diff between any two instances, at
the working tree or across git refs (branches, tags, commits), so
"staging today vs prod at v24.2" is one dropdown away.

**Always live** — a background sync keeps the working tree fast-forwarded;
external commits appear in the grid automatically, and the Repository
Changes inbox surfaces new/changed/deleted config files with one-click
import or retire.

**Multi-user platform (optional)** — configure a GitHub OAuth app and
Configer becomes a shared deployment: sign-in, per-application roles
(viewer / editor / **approver** — publishing is approver-gated), member
management for deployment admins, an audit trail of every action, and
commits attributed to the real person. Platform data lives in an embedded
SQLite file by default (zero external services); set `DATABASE_URL` for
PostgreSQL in production. Without OAuth configured, none of this surfaces —
the single-user self-hosted experience stays untouched.

## Run it

```bash
make install   # first time: go modules + npm
make dev       # backend :8080 + frontend :5173, Ctrl-C stops both
```

The bundled `sample-repo/` (a plain-folders telco fixture with six
instances, shared config, XML vendor files, and a deduplicated namespace)
is served out of the box. Interactive API docs: `http://localhost:8080/api/docs`.

```bash
# Docker (frontend :8088, backend :8080, Postgres)
cd deploy && docker compose up --build
```

Configuration is documented in [`.env.example`](.env.example) and
[`CONFIG.md`](CONFIG.md). Development workflow: [`DEVELOPMENT.md`](DEVELOPMENT.md)
and [`DEVELOPER_GUIDE.md`](DEVELOPER_GUIDE.md). Architecture and conventions
for contributors (human or AI): [`CLAUDE.md`](CLAUDE.md).

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/grid` | The parameter×instance matrix with provenance + validation. |
| GET | `/api/project` | Application summary (`initialized: false` routes to onboarding). |
| POST | `/api/discover` | Read-only proposal: layout, instances, deduplicated parameters. |
| POST | `/api/init` | Initialize: one commit writing `.configer/`. |
| PUT | `/api/values` | Validated cell edit staged into the draft (422 on invalid). |
| PUT | `/api/files/draft` | File-mode save: managed values become cell edits, else a file edit. |
| GET | `/api/render/{instance}` | The instance's real files with the draft applied in memory. |
| POST/PUT/DELETE | `/api/instances…` | Instance lifecycle (create/retire stage structural changes). |
| PUT/POST/DELETE | `/api/parameters…` | Parameter metadata (attributed commits); retire deletes the keys everywhere. |
| GET/POST | `/api/changes…` | Change requests: list, draft, submit, merge (approver-gated), reject. |
| GET | `/api/compare` | Parameter-level diff, instance⇄instance, optionally at git refs. |
| POST | `/api/scan` · `/api/import` | Incremental import of new files into the catalog. |
| GET | `/api/repo/findings` | External-commit inbox (drift detection). |
| GET | `/api/auth/me` · `/api/audit` · `/api/repos/{id}/members` | Platform: identity, audit trail, roles. |

Full spec: `/api/openapi.yaml` (served) — every repo-scoped route also mounts
under `/api/repos/{id}/…` for multi-application workspaces.

## Repository layout

| Path | Description |
|------|-------------|
| `backend/` | Go API: layout adapters, discovery/dedup, the pathedit engine (surgical YAML/JSON/XML edits), resolver, grid, change requests, git engine, platform (auth/store). |
| `frontend/` | React + Vite + TypeScript + Ant Design SPA: grid, file mode (Monaco), onboarding wizard, instances, compare, approvals, source control. |
| `sample-repo/` | Write-back-native demo fixture served out of the box. |
| `deploy/` | docker-compose stack (backend + frontend + Postgres). |
