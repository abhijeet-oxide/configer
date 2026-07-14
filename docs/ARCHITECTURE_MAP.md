# Configer Architecture Map (read this first)

Read this **before touching a feature**. Each block names the few files that feature lives in and
how they connect, so you never load the whole codebase. Format per block:
**Entry -> collaborating files -> state keys -> data route -> known gaps.**

Conventions: frontend files are under `frontend/src/` (component paths shortened to the basename);
backend packages under `backend/internal/`. No em dashes anywhere in this repo; use `:` `;` `,` or
restructure.

---

## Shell, navigation, routing

- Entry: `App.tsx` (three responsive tiers; `body()` is the section router; `editorLayout()` is the
  3-pane Configuration workspace).
- Nav: `NavRail.tsx` (`buildItems` = the left menu; flat items today) and `TopBar.tsx` (breadcrumb,
  repo switcher, global search, theme/fullscreen, approvals bell).
- State: `store.ts` (`useUI`) field `section: string` is the whole router; `repoId` = active
  application; theme fields. `offline.ts` (`useConn`) = online/queued/syncing + localStorage
  snapshots.
- No React Router. "Pages" are `section` string values switched in `App.tsx`.
- Gaps (Phase 0): nav is flat and Git-centric; make it application-centric with a per-app view set
  and a version/environment/instance breadcrumb; rename `config` section label Editor ->
  Configuration.

## Configuration workspace (the 3-pane editor)

- Entry: `App.tsx` -> `editorLayout()` (rendered when `useUI().section === "config"`).
- Panes: `CategoryTree.tsx` (left: Parameter Groups tree + Systems/instances tree) |
  `ParameterGrid.tsx` (center: virtualized param x instance grid, typed editors) |
  `DetailsPanel.tsx` (right: inspector; falls back to `ProjectOverview` when nothing selected).
- Layout: `react-resizable-panels` `PanelGroup autoSaveId="configer-main"`.
- State: `store.ts` -> `section`, `categoryKey`, `selectedParamId`, `selectedInstance`,
  `jump{kind,id,n}`, `search`, `filters`, `prefs`.
- Data: `api.ts` grid query (`["grid"]`) <- `GET /api/grid` <- backend `grid.Build` (package
  `grid/`), resolved via `resolver/` (scope precedence default<global<env<site<zone<instance).
- Sync: tree -> grid works via `store.setJump` one-shot -> `ParameterGrid` `useEffect` (scroll +
  flash). **Reverse sync (grid -> tree, file -> grid) is NOT built:** emit `setJump` from those
  click handlers to complete it (Phase 2).
- Gaps: full-screen currently maximizes the whole app not just this workspace; panels not
  width-remembering/collapsible enough; Group Overview lives inside the grid (move to Overview).

## Parameter grid

- File: `ParameterGrid.tsx` (virtualized AntD `Table`; rows = params, columns = instances). Inline
  editors: `NumberEditor`, `StringEditor`, `EnumEditor`, `ListEditor`, boolean `Switch`. Right-click
  menu (reset/exclude/copy-to/undo), per-column value filters, `GlobalPrompt` for global-scope edits.
- Validation: `rules.ts` (client) mirrors backend `validate/` (server 422 on `PUT /api/values`).
- Edits: `PUT /api/values` / `DELETE /api/values` stage into the draft CR.
- Gaps: hosts a Group Overview strip that belongs in Overview (Phase 2); no live-render trigger yet
  (Phase 3); no reverse highlight emit (Phase 2).

## Parameter inspector

- File: `DetailsPanel.tsx` (tabs: Details editable form, Schema via `RuleEditor.tsx`, History TODO,
  Depends On). Attach/remap source via `PathPicker.tsx`. Retire action.
- Data: `["parameter",id]` <- `GET /api/parameters/{id}`; edits `PUT /api/parameters/{id}`.
- Gaps (Phase 2): expand into a knowledge center: Overview / Description / History / Dependencies /
  Validation / Usage / Git / AI / Version History.

## Category and Systems tree

- File: `CategoryTree.tsx` (two linked AntD trees: category hierarchy + instances grouped by
  environment). Both drive grid navigation via `setCategory` / `selectParam` / `selectInstance` /
  `setJump`.
- Gaps (Phase 2): make panels resizable, collapsible, width-remembering, scroll-synced.

## Rendered Files

- File: `RenderedFilesView.tsx` (SINGLE integration point; today `Tree.DirectoryTree` + read-only
  `<pre>`; `langOf()` only computes a language tag, no highlighting).
- Data: `["render",instance]` <- `GET /api/render/{instance}` <- backend `render.Instance()`
  (package `render/`), which returns exact `generated/<instance>/...` file contents.
- Gaps (Phase 3): no Monaco; no file search/favorites; no branch/commit/tag selector; instance
  selector is single (want Default/All/filter); no live re-render; **duplicate-file bug** (check
  `render.Instance` output and explorer node keys).

## Compare

- File: `ComparePanel.tsx` (pick two instances; side-by-side or inline unified param diff).
- Data: `GET /api/compare` <- backend `diff/` (semantic parameter-level comparison).
- State: `compareLeft` / `compareRight` in `store.ts`.

## Change-request pipeline (git-native)

- FE: `SubmitChangesButton.tsx` -> TopBar review modal -> `ChangeRequestsView.tsx` /
  `ApprovalsView.tsx`; `CrSteps.tsx` = shared state stepper + `StateTag` / `stateMeta`.
- BE: `PUT/DELETE /api/values` -> `change/` (draft) + `crstore/` -> `changeset/` (Submit cuts
  `configer/cr-N`) -> `repobackend/` seam (`local.go` git worktree | `remote.go` Git-data API) ->
  `provider/` (GitHub PR create/merge/close). Branch name in `changeset.go`.
- State: Draft -> UnderReview -> Approved -> Published/Rejected.
- Gaps (Phase 4): present CRs as first-class PR-like objects; richer empty state on Approvals.

## Repository Changes (drift / reconcile)

- File: `RepoChangesView.tsx` (findings inbox: new/changed/deleted/renamed files; jump into Import).
- BE: `GET /api/repo/findings` / `POST /api/repo/findings/ack` <- `internal/api/reconcile.go`;
  background ahead/behind loop in `internal/api/sync.go`.
- Handoff: `store.importFocus` hands a file/folder to the Import wizard.
- Gaps (Phase 4): scope under the application; per-event Compare/Ignore/Accept/Create-CR; detect
  vendor/Helm/OCI/schema updates; richer layout.

## Import / application onboarding

- File: `ImportWizard.tsx` (AntD `Steps`: connect repo -> scan -> choose+enrich -> review+init).
  Interactive attach via `PathPicker.tsx`; add param via `AddParameterModal.tsx`.
- BE: `POST /api/scan` <- `ingest/` (walks tree, runs `parsers/`); `POST /api/import` <-
  `internal/api/reconcile.go` `importParameters` -> `writer/` -> commit. Connect a repo:
  `POST /api/repos` <- `internal/api/hub.go` `connect`.
- Gaps (Phase 4): reframe as Add Application (Connect Git -> Authenticate -> Select Repository ->
  Discover Artifacts -> Review -> Import).

## Dashboard / Overview

- File: `DashboardView.tsx` (health tiles, category donut, activity sparkline, recent history) using
  `charts.tsx` (dependency-free inline SVG). **Currently NOT wired to any `section`** (orphaned).
  `WorkspaceView.tsx` is the portfolio landing (repo cards + selected config overview).
- Gaps (Phase 1): wire `DashboardView` as the per-application Overview command center; fill dead
  whitespace across views with stats/summaries/activity.

## Backend data model (canonical)

- One file: `model/model.go` (`Catalog`, `Parameter`, `Instance`, `Scope`, `Overlay`,
  `InstanceRegistry`, `ScopeOverlays`). Maps 1:1 to `.configer/*.yaml` (see `sample-repo/`).
  **No DB; Git is the source of truth.**
- Load: `project/` reads the working tree into an in-memory `Project`.
- Round-trip: `parsers/` (files -> candidate params) is the inverse of `render/` (params -> files);
  `resolver/` computes effective values by scope precedence; `transposers/` synthesize artifacts not
  in source (e.g. `transposers/flux.go`).
- Gap (Phase 5): a **reverse-render** does not exist. To parse an edited rendered file back into
  parameter deltas, add `internal/reverse/` (or extend `render/`) reusing `parsers/` + `resolver/` +
  `writer/`, exposed as `POST /api/render/{instance}/apply`, staging a draft CR.

## Git backend seam (local vs remote)

- Seam: `repobackend/repobackend.go` (`Backend` interface). `local.go` wraps `gitengine/` (git CLI:
  clone, worktree-per-CR, commit, push, merge). `remote.go` wraps `remoterepo/` (GitHub Git-data
  REST API: no clone; materialize / refresh / partial commit / merge). PR host: `provider/`.
- Workspace registry: `workspace/` (persisted `workspace.json`); Hub routes in `internal/api/hub.go`
  mount every per-repo endpoint under `/api/repos/{id}/...`.

## State stores and theming

- `store.ts` (`useUI`): section, repoId, selections, jump, filters, prefs, theme (mode/brand/font),
  navCollapsed, importFocus. Some fields persisted to `localStorage`.
- `offline.ts` (`useConn`): online/queued/syncing; `saveSnapshot`/`loadSnapshot`; offline edit queue
  drained by `OfflineReplay` in `App.tsx`.
- Theming: `theme.ts` (AntD token builder, brand palettes, font scales) + `index.css`.
  `useSwitchRepo.ts` switches active repo and clears the query cache.

## HTTP surface (quick index)

- Reads: `GET /api/{project,grid,instances,parameters/{id},compare,render/{instance},plugins,meta,
  validation/presets}`.
- Ingest: `POST /api/scan`, `POST /api/import`, `POST /api/parameters/retire-file`.
- Cell edits (staged): `PUT/DELETE /api/values`. Catalog edits (direct commit): `PUT/POST/DELETE
  /api/parameters/{id}`.
- Change requests: `GET /api/changes`, `/api/changes/draft`, `/api/changes/{id}`,
  `POST /api/changes/{id}/{submit,merge,reject}`.
- Repo/git: `GET /api/repo/status`, `POST /api/repo/sync`, `GET /api/repo/findings`,
  `POST /api/repo/findings/ack`.
- Workspace: `GET /api/workspace`, `GET/POST /api/repos`, `DELETE /api/repos/{id}`; per-repo routes
  under `/api/repos/{id}/...`.
