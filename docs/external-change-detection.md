# External change, instance discovery and version lifecycle

An assessment of what Configer does today when a repository changes outside
Configer - somebody adds a site folder, edits a file in their editor, upgrades a
release - what it misses, and what it should do. Everything in "Reality today"
was reproduced against `sample-repo` on a local connection; the commands and
the observed responses are quoted, not inferred.

---

## 1. The two problems reported, explained

### 1.1 A `.git` inside every instance folder

**Is it a real problem?** Yes, and Configer has no defence against it anywhere.
There is not one mention of submodules or nested repositories in the codebase -
`grep -ri "submodule\|gitmodules"` over Go, TS and docs returns nothing.
Onboarding never looks for them, connect never warns, and the write path
assumes a single flat repository.

**How the folders probably got one.** Two candidates, and both are worth
fixing:

1. **Configer put them there.** `layout.copyTree`
   (`backend/internal/layout/layout.go:175`) is what "clone an instance" uses,
   through `scaffoldByCopy`. It walks the source folder and copies **every
   regular file** with no name filtering at all - so if the source instance
   folder contained a `.git`, `.terraform`, `node_modules` or an editor
   directory, the copy gets one too. Ironically `ingest.SkipDir` already
   maintains exactly the right skip list for scans; the copier does not use it.
   The same function also flattens every file to mode `0644` (an executable
   hook or script silently loses its bit) and silently drops symlinks.
2. **They were always there.** Per-site repositories cloned into one parent
   folder is a common telco/GitOps arrangement, and pointing Configer at the
   parent produces exactly what was seen. Configer accepted it without a word.

**Why it broke VS Code, and why it is worse than it looked.** A nested
repository is not cosmetic - it stops the outer repository from tracking the
folder at all, in one of two ways:

- Nested repo **with no commit**: `git add -A` fails outright. Reproduced:

  ```
  error: 'instances/newsite/' does not have a commit checked out
  fatal: adding files failed
  ```

- Nested repo **with a commit**: `git add -A` records a *gitlink* (mode
  `160000`) instead of the files. The instance's `values.yaml` is then invisible
  to the outer repository forever.

Configer commits with `git add -A` in exactly one place
(`gitengine.CommitAllAs`, `gitengine.go:483`), and every write goes through it:
catalog edits, imports, onboarding, and every change-request submit inside its
worktree. So **one stray nested repository anywhere in the tree bricks every
write in the product**. Reproduced against a running backend:

```
$ curl -X PUT .../api/parameters/platform-registry -d '{"description":"probe"}'
{"error":"git add -A: exit status 128: error: 'instances/newsite/' does not
have a commit checked out\nfatal: adding files failed","code":"internal_error"}
```

That is a 500 carrying raw git jargon straight to the user, against the
project's own rule that errors are plain words and a bad precondition is a
state, not an error.

**Should a submodule be allowed?** As a concept, yes - a shared base pulled in
as a submodule is legitimate GitOps. But **today it is silently broken**:
`pathedit` walks the filesystem, so Configer will happily read and edit a file
inside a submodule, and then `git add -A` in the parent records only the
gitlink. The edit lands on disk, the commit contains nothing, the change request
reports success, and the value never reaches the branch. Silent loss of a
committed change is the worst failure mode in this product. Until submodules
are handled deliberately, files inside one must be refused, not written.

### 1.2 The copied folder and the commit that never appeared

Reproduced step by step (backend on `:8099`, local folder connection):

| Step | What Configer showed |
|---|---|
| `cp -r instances/prod-us-east instances/prod-ap-south`, uncommitted | `findings: []`, instance list unchanged. **Completely invisible.** |
| `git commit` the new folder | 2 × `new_file` findings, plus one `new_folder` finding whose path is **`instances/`** - not `instances/prod-ap-south/` |
| Same commit in the timeline | present, but `kind: "none"`, `summary.total: 0` - the UI renders it as **"No configuration change"** |
| Register it by hand in `.configer/instances.yaml` and commit | grid picked the new column up **immediately**; timeline classified that commit `structural / instance added` |

Four separate causes, all confirmed in code:

1. **Configer only ever looks at commits.** `findings`
   (`api/reconcile.go:44`) diffs an acknowledged SHA against HEAD. There is no
   `git status` anywhere in the codebase - no `--porcelain`, no dirty check.
   Uncommitted work in the working tree does not exist as far as Configer is
   concerned, even though on a local connection that tree *is* the user's
   folder.
2. **An instance is whatever `.configer/instances.yaml` says, and nothing
   else.** Folder discovery (`layout.Detect`) runs during onboarding only.
   After `/api/init` there is no rescan: `/api/discover` still works as an
   endpoint but nothing in the UI calls it, and `/api/init` returns 409 on an
   initialized repository. The import wizard rescans for **parameters** and
   never proposes **instances**.
3. **There is no finding type for "a new instance appeared".** The five types
   are `new_file`, `file_changed`, `file_deleted`, `file_renamed`,
   `new_folder`, and the only offered actions are "import parameters" and
   "retire". "Adopt this folder as an instance" does not exist as a concept.
   The `new_folder` finding is also mis-keyed: `strings.Split(dir, "/")[0]`
   (`api/reconcile.go:130`) reduces `instances/prod-ap-south` to `instances`,
   so on the standard layout it always names the bucket everybody already
   knows about and never the new site.
4. **The timeline classifies by resolved cells, so a new site is a non-event.**
   `readSnapshot` iterates `p.Registry.Instances`; an unregistered folder
   contributes no cells, so `diffStates` returns nothing and the commit is
   labelled "No configuration change" - which is exactly "nothing showed up".

Two more things worth knowing about your setup:

- **If you connected a git URL rather than a folder, you were editing a
  different copy.** `connect` uses your path directly only when it is a
  directory (`connect.go`, `Path: abs`); a URL is cloned into
  `<dataDir>/repos/<id>`. Local edits are then invisible until pushed.
- **A local folder with no remote polls nothing.** `StartSyncLoop` returns
  immediately when `CanPublish()` is false, and that is `repo.HasRemote()`.
  Findings then only refresh while the Repository tab is open (30s) or on
  "Check now".

The read path itself is honest: as soon as the registry named the folder, the
grid showed it without a restart, because `treecache` revalidates each file by
its own stat. **The problem is entirely detection and notification, not
staleness.**

---

## 2. Reality today: what is detected, by mechanism

| Mechanism | Detects | Trigger | Where |
|---|---|---|---|
| `treecache` stat revalidation | value + catalog edits made outside Configer | next read | `api/treecache.go` |
| `findings` (ack SHA → HEAD diff) | new / changed / deleted / renamed config files, new folders | 30s poll on the Repository tab | `api/reconcile.go` |
| `StartSyncLoop` | commits landing on the remote; fast-forwards the tree | poll interval, remote-backed repos only | `api/sync.go` |
| `timeline` | per-commit configuration diff, instance add/retire, version moves | on view | `api/timeline.go` |
| `layout.Detect` | instance folders | **onboarding only** | `layout/` |
| `grid.cellState` | new / deprecated / not-applicable per cell | every grid build | `grid/grid.go:288` |

And what is **not** detected, at all:

- uncommitted working-tree changes;
- new instance folders after onboarding;
- instance folders deleted or renamed on Git;
- nested repositories and submodules;
- a new software version arriving anywhere (tag, release, `Chart.yaml`
  `appVersion`, image tag, Kptfile);
- parameters that exist in one instance's files but not in another's;
- required parameters that are unset.

### The version lifecycle, specifically

The model is there and the rendering is there. Nothing can populate it.

- `Parameter.VersionIntroduced` / `VersionDeprecated` (`model/model.go:144`)
  drive `cellState` → `new` / `deprecated` / `na`, and the grid, DetailsPanel
  and MobileParamList all render those states.
- **No API can set either field.** `PUT /api/parameters/{id}` accepts type,
  validation, displayName, description, category, scope, secret, default,
  derived and bindings - no version fields - and `writer.ParamPatch` has no
  version fields either. Discovery never infers them, import never asks, the
  onboarding wizard never offers them. `DetailsPanel.tsx:299` shows them as
  read-only text that is always `-`. **The only way to set them is to
  hand-edit `.configer/parameters.yaml`.**
- **`new` means "exactly equal", not "recently added"**
  (`grid.go:298`, `case 0`). A parameter introduced in v24.3.5 is never
  flagged for an instance that upgraded straight from v24.3.1 to v24.4.0 - the
  case where flagging matters most.
- **An unset cell is always valid** (`grid.go:130`: `if state ==
  StateNotApplicable || !res.Set { cell.Valid = true }`), even with
  `validation.required: true`. So "this new parameter must be populated" is
  representable in the schema and invisible in the product.
- **`softwareVersion` is hand-typed per instance** and never derived from
  anything in the repository.
- `semver.Compare` truncates at the first `-` or `+`, so `v24.3.1-rc1` equals
  `v24.3.1`, and treats non-numeric segments as 0, so calendar versions
  (`2024.03` vs `24.3`) compare wrongly.

Net effect: **a user cannot today learn from the tool which parameters an
upgrade introduces, which of them are mandatory, or which are unset.** The
grid's `new` and `na` states are, on any real repository, permanently unused.

---

## 3. Bugs

Ordered by severity. Each has been confirmed in code, and the first two were
reproduced end to end.

| # | Severity | Bug | Evidence |
|---|---|---|---|
| B1 | **Critical** | A nested repository anywhere in the tree makes every Configer write fail, with a raw git error shown to the user | `gitengine.go:484`; reproduced 500 above |
| B2 | **Critical** | Files inside a submodule are read and edited by `pathedit`, but `git add -A` in the parent records only the gitlink - the change request succeeds and the value never lands | `gitengine.go:484` + no submodule awareness |
| B3 | High | `copyTree` copies `.git`, `node_modules`, `.terraform` … into every cloned instance, manufacturing B1/B2 | `layout/layout.go:175`, no skip list |
| B4 | High | `copyTree` flattens all file modes to `0644` and silently drops symlinks | `layout/layout.go:196` |
| B5 | High | A new instance folder committed on Git is never surfaced as an instance; it appears only as loose "new file" noise | `api/reconcile.go`, no `new_instance` type |
| B6 | Medium | `new_folder` findings name the first path segment, so they always read `instances/` | `api/reconcile.go:130` |
| B7 | Medium | A commit that adds a whole site is labelled "No configuration change" in the timeline | `api/timeline.go:66` iterates the registry only |
| B8 | Medium | An unset cell is unconditionally valid, so `required: true` never fires on the case it exists for | `grid/grid.go:130` |
| B9 | Medium | Version metadata is unreachable through every write path | `api/parameters.go:37`, `writer.ParamPatch` |
| B10 | Medium | `cellState` flags `new` only on an exact version match, so any multi-release upgrade flags nothing | `grid/grid.go:298` |
| B11 | Low | Uncommitted changes are invisible; on a local connection the user's own editor work does not register | no `git status` in the codebase |
| B12 | Low | `semver.Compare` ignores prerelease identifiers and mis-orders calendar versions | `semver/semver.go:42` |
| B13 | Low | An instance folder deleted or renamed on Git produces file-level findings but never says "this instance is gone" | `api/reconcile.go` |
| B14 | Low | `addInstance` has no `folder` field, so an existing folder can only be adopted if it happens to be `instances/<name>` | `api/instances.go:20` |

---

## 4. Fixes and improvements

### 4.1 Make nested repositories a state, not a crash

**Detect at connect and at onboarding.** Walk for `.git` entries below the root
plus `.gitmodules`, and report them as part of the layout proposal. Three
outcomes, each with plain words:

- *A submodule* (`.gitmodules` names it): show it, and mark its instances
  read-only with "these files live in another repository; Configer cannot
  commit them here yet".
- *A nested clone that is not a submodule*: "`instances/foo` is a separate
  repository. Git will not track its files from here. Remove its `.git` folder,
  or connect it as its own application."
- *A nested repo with no commit*: the same, and say it is what makes saving
  fail.

**Stop manufacturing them.** Give `copyTree` `ingest.SkipDir`, preserve modes,
and copy symlinks as symlinks. One small change to
`layout/layout.go`, and the fixture set under `layout/testdata/` is the right
place for a golden test with a `.git` in the source folder.

**Stop the raw error.** `CommitAllAs` should recognize exit-128 `add` failures
and translate: "A folder in this repository is a separate Git repository
(`instances/newsite`), so Git cannot record its files. Remove its `.git` folder
and try again." Same treatment for the gitlink case, which needs to be detected
*before* the commit: after `git add -A`, refuse to commit if any path Configer
just wrote is not in `git ls-files` output. That single guard closes B2 - never
report a change published when the diff does not contain it.

### 4.2 Detect instances, not just files

Add a **sixth finding type, `new_instance`**, produced by running the layout
adapter's discovery against HEAD and subtracting the registry. It carries the
folder, the instance name it proposes, the environment/region it guessed, and
the count of parameters that already resolve against it. Its resolution is a
one-click **Adopt as instance** that stages an ordinary `add-instance` draft
item (metadata only, no scaffolding, because the folder already exists) - so
adopting a colleague's site is a reviewable change request like everything
else, not a side effect.

That needs three supporting changes:

- `addInstance` accepts a `folder`, so adoption works for `environments/`,
  `clusters/eu/site-a` and any other real layout (B14).
- `applyStructural` must not scaffold when the folder already exists - adopt it
  instead of erroring "target folder already exists".
- The mirror case: `retired_instance` when a registered folder disappears from
  HEAD (B13).

Fix `new_folder` to name the actual directory, and drop it entirely when a
`new_instance` finding already covers that path (B6).

Make the timeline agree: classify a commit that adds or removes an instance
*folder* as `structural`, not `none`, even when the registry has not caught up
(B7). "A site appeared" is the single most consequential thing that can happen
to a fleet, and it currently reads as nothing happened.

### 4.3 Show uncommitted work

On a local connection, Configer's tree is the user's tree, and pretending
otherwise is what made the first hour confusing. Add `git status --porcelain`
behind `Backend.WorkingChanges()` and surface it as a distinct band at the top
of the Repository tab: "3 uncommitted changes in the working folder", with the
file list and a plain sentence that Configer works from commits, so these will
be picked up once committed. Not a finding (there is nothing to import yet), not
an error - a state. On remote-backed connections the band never appears.

### 4.4 Give version lifecycle an actual life

This is the largest gap and the one the original question was really about. In
dependency order:

**(a) Make the fields writable.** Add `versionIntroduced` / `versionDeprecated`
to `writer.ParamPatch` and `PUT /api/parameters/{id}`, expose them in the
parameter details panel and in the import wizard's per-parameter draft. Without
this nothing else in this section can happen.

**(b) Fix the comparison.** `new` should mean "introduced after the version
this instance came from", not "equal to it" (B10). That needs a *previous*
version per instance, which the timeline already knows: the last commit where
`softwareVersion` changed. Then "new since your upgrade" is answerable
precisely, and the badge survives multi-release jumps.

**(c) Make unset-and-required visible.** Drop the blanket `Valid = true` for
unset cells when `validation.required` is set (B8) and count them. That single
change turns the grid into the answer to "what must I populate?".

**(d) Detect that a version arrived.** Three sources, cheapest first:

1. **Git tags and releases** on the managed repository - a new tag matching the
   version pattern is a release drop. `gitengine.Tags()` already exists.
2. **Version-bearing files inside an instance folder** - `Chart.yaml`
   `appVersion`, a Kptfile, an image tag in a values file. A recognizer per
   convention in `recognizers/`, feeding a proposed `softwareVersion` patch
   rather than writing one. This also removes the hand-typing of
   `softwareVersion` entirely for repositories that carry it.
3. **A version-drop folder** - the existing "several new config files under one
   folder" heuristic, made accurate once it names real folders.

Surface the result as a finding: "`prod-ap-south` looks like it moved to
v24.4.0" with an accept action that stages the instance patch.

**(e) Infer the version metadata instead of asking for it.** This is the
enrichment the question asked for, and the repository already holds the
evidence. A parameter's `versionIntroduced` is derivable: find the earliest
commit where any of its bindings first resolved, then take the
`softwareVersion` in force at that commit. `parameterHistory` already walks
per-parameter history, and `snapshotcache` already memoizes per-commit states -
so this is an offline pass over existing machinery, not new plumbing.
`versionDeprecated` is the mirror: the version in force when the last binding
stopped resolving anywhere. Run it as a **proposal** the user accepts in bulk
("Configer found version metadata for 47 parameters - review and apply"), never
silently, and cache it so it costs nothing per read.

**(f) The upgrade preview.** With (a)-(e) in place, the deliverable the
question describes becomes a real screen: pick an instance and a target
version, and get

- parameters that **become applicable** (`na` → `new`), split into required
  (must be populated before upgrading) and optional;
- parameters that **become deprecated**, with their current values, so they can
  be removed in the same change;
- parameters whose validation changes between versions;
- a single **"stage all defaults"** action producing one reviewable change
  request titled after the upgrade.

That is the point at which "which new parameters must I populate if I upgrade?"
is answered by looking at the tool rather than by reading release notes.

### 4.5 Smaller items

- `semver.Compare`: order prerelease identifiers below their release, and
  either support calendar versions or reject them at entry with a plain message
  (B12).
- Findings currently re-report a file every poll until acknowledged; once
  `new_instance` and adoption exist, adopting should resolve the related
  `new_file` findings automatically rather than leaving the user to also press
  "mark as seen".
- A local connection with no remote should say so once, in the Repository tab:
  "This folder has no remote, so there is nothing to poll - changes appear when
  they are committed here."

---

## 5. Suggested order

1. **B1/B2/B3 - the nested-repo family.** A product that silently drops a
   published change, and whose every write can be bricked by a stray folder,
   fixes that first.
2. **B5 + adoption + B7 - instance detection.** This is the reported scenario
   end to end, and it is self-contained.
3. **4.4(a)-(c) - writable version metadata, correct `new`, required-and-unset.**
   Small, and they switch on grid states that are dead code today.
4. **4.3 - uncommitted work.** Cheap, and removes the "why is nothing
   happening" confusion for every local user.
5. **4.4(d)-(f) - version detection, inference and upgrade preview.** The
   differentiating capability, and it stands on everything above.
