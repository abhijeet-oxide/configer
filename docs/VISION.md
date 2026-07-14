# Configer — Product Vision & Reimagined UX

This document captures the target product experience and the architecture decisions that
follow from it. It complements `docs/PLAN.md` (the detailed engineering plan and current
status). Where the two disagree, this file describes the **intended direction**; PLAN.md's
"Current Implementation Status" section describes **what is built right now**.

## The one-sentence intent

A user who has never thought about Git, YAML paths, Kustomize overlays, or Helm values should
be able to open Configer, connect a repository, and **edit configuration values for many
deployment instances in a spreadsheet** — with validation and review built in — while every
edit is, underneath, a real change to a real file, committed on a branch and merged via a pull
request that Configer manages on their behalf.

Two audiences, one tool:
- **The operator** never leaves the table. They pick an instance column, change a value, get
  instant validation, and hit "submit for review". They never see a diff or a branch name.
- **The engineer** can, at any moment, open Source Control and see exactly which files changed,
  on which branch, and what the resulting file looks like. Nothing is hidden; it is just not
  *required*.

## The onboarding experience (target)

The first thing a user sees with no applications is **Create application** — not a Git URL box.

1. **Create application** — the user names the application (mandatory, first field).
2. **Authorize with GitHub (OAuth)** — the user signs in; Configer reads *their* repositories.
   Public repos work immediately; private repos work once they approve the OAuth scope.
3. **Select repository** — a type-to-filter dropdown over the user's repositories.
4. **Select branch** — enabled only after a repository is chosen; branches sorted by recent
   activity, default branch pinned on top.
5. **Scan & detect** — Configer scans the branch and recognises well-known layouts:
   **Kustomize** (base + overlays), **Helm** (`values.yaml` + per-env values), **kpt/KRM**,
   **Flux** `HelmRelease`, plain **ConfigMaps/Secrets**, and generic YAML/JSON/XML. An optional
   "Managed by" selector (Flux / Kustomize / Helm / custom) can pin the interpretation; when the
   layout is unambiguous it is pre-selected and the step is skippable.
6. **Derive structure** — from the folder layout Configer proposes **instances** (e.g. one per
   Kustomize overlay directory) and their metadata (environment, region, zone, site, deployment
   group), and the **config files** and **parameters** within. Anything it can derive, it fills
   in; anything it cannot, the user annotates. If there is a single unnamed config, the user
   names the instance it belongs to. Manual file selection is always available as a fallback.
7. **Import parameters** — the existing import step (choose, enrich, deduplicate) becomes the
   next step of creation, not a separate feature.
8. **Initialize** — Configer writes the `.configure/` metadata, commits it, and opens the change
   as a single reviewable item ("Initialize <application>") with a progress bar. Approve &
   publish merges it to the main branch. The overview page then becomes the home for the app.

Steps that are not needed for a given repository are skipped automatically. The whole flow is
OAuth-based: the user signs in and Configer is an abstraction on top of *their* Git identity.

## The pivotal architecture decision: write-back-native vs render-out

This is the single most consequential decision and it is **not yet reflected in the built
code**, so it is called out explicitly.

- **Render-out (what is built today).** Values live inside `.configer/` overlays
  (`instances/<name>/overlay.yaml`, `scopes.yaml`). The renderer *generates* fresh files into
  `generated/<instance>/`. The repository's original config files are never edited back. The
  catalog records a single `source` (file + path) per parameter as provenance.

- **Write-back-native (the vision).** `.configure/` holds **only metadata** — parameter
  definitions, validation, and **mappings**; instance definitions and their metadata. **Values
  stay native** in the repository's own files (Kustomize overlays, Helm values, ConfigMaps).
  Editing a table cell **writes back** into the actual file at the mapped location. Adding an
  instance **creates a new folder** parallel to the existing ones, following the repo's own
  convention (Kustomize-style). Configer manages the `.configure/` folder and, through the
  mappings, the real files — no separate `generated/` tree, no database; Git is the truth.

Implications of adopting write-back-native (the requested direction):

1. **Multiple mappings per parameter (dedup).** `model.Source` (one file/path) becomes a list of
   targets. A parameter like `namespace`, defined in many files, appears **once** in the table;
   the Parameter Details panel lists **all** the places it maps to. A cell edit fans out to every
   mapping (per instance).
2. **A write-back engine** replaces overlay writes: given (parameter, instance, value), resolve
   the instance's file(s) for each mapping and edit YAML/JSON/XML in place at the mapped path,
   producing minimal diffs.
3. **Instance ⇄ folder binding.** Each instance knows its file set (e.g. its overlay dir).
   Creating an instance scaffolds that folder from the base/convention.
4. **Layout adapters.** Kustomize/Helm/Flux/kpt adapters translate between "the table" and "the
   files" both ways, and know where a new instance's folder goes and what the output directory is
   (Flux keeps its own dir; nothing is forced under `generated/`).

The change-request / branch / PR / approval pipeline is **unchanged** by this decision — it
already commits arbitrary working-tree edits to a branch and opens a PR. Only the *write* step
(what the edit touches) changes.

## The editor experience: a table that is also Git

- **Table view** is the primary surface: rows are parameters, columns are instances, with typed
  editors, validation, scope resolution, bulk edits, and compare.
- **Source Control** (shipped) mirrors VS Code for anyone who wants to see the Git reality: a
  bottom status bar with the branch, remote state and a one-click pull; a Source Control panel
  listing active (uncommitted) changes **grouped by file** with per-change undo; and a
  **before → after** for each edit. The file browser marks changed files (an `M` marker) and
  shows the branch + active-change summary beneath the tree.
- **Two-way link.** A change made in the table shows up as a modified file in the browser and as
  an entry in Source Control; opening the rendered/native file shows the new content. The user
  can live entirely in the table, entirely in the files, or move between them.
- **Workflows, not Git.** "Submit for review" cuts the branch and opens the PR. "Approve &
  publish" merges. Validation blocks bad values before they can be committed. The user performs
  *actions in Configer*; Configer performs *operations in Git*.

## Staged roadmap

- **Stage 0 — UX consistency (done).** Applications page (flicker fixed, faithful skeletons,
  unified terminology), create-application → scan/import handoff.
- **Stage 1 — VS Code Source Control (done).** Bottom status bar, Source Control panel
  (changes-by-file, undo, pull), changed-file markers + branch footer in the file browser.
- **Stage 2 — Layout detection & guided onboarding.** Kustomize/Helm/Flux/kpt detection at scan
  time; derive instances + metadata from folder structure; fold import into a single
  create-application wizard. (Testable against the sample repo; no OAuth required.)
- **Stage 3 — Write-back-native model.** `[]Source` mappings + dedup; the write-back engine;
  instance-as-folder scaffolding; `.configure/` = metadata only. **The pivotal change above.**
- **Stage 4 — GitHub OAuth onboarding.** User sign-in, repo dropdown, activity-sorted branch
  picker. (Requires a GitHub OAuth app: client id/secret + callback host.)
- **Stage 5 — Deep two-way polish.** Parameter Details showing all mappings; a Git graph /
  active-changes visualization; new-instance scaffolding UX.

## Open decisions to confirm before Stage 3

- **Commit to write-back-native and retire the `generated/` render-out path?** (The vision says
  yes; the built code does render-out. This is expensive to reverse either way.)
- **Sample application** should ship as a **read-only demo** seeded on the Applications page
  (consistent with OAuth-only for real apps), rather than a local-path connection.
