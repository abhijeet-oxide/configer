# Workflow & Version-Control Assessment

How Configer stands on real-world change management: promotion, rollback at
different scopes, attribution, concurrency, and the advanced Git operations
(3-way merge, cherry-pick, cross-version re-apply) that production teams reach
for. Every claim below is grounded in the code as it exists today, with file
references, and each scenario carries a plain verdict: **Handled**, **Partial**,
or **Gap**.

---

## 1. Executive summary

Configer's core loop - draft an edit, submit it as a branch + commit + PR, get
it approved, publish by merge - is genuinely Git-native and well built. Every UI
action lands as an ordinary Git operation with real attribution, and the review
gate (approval, separation of duties, minimum approvals) is real policy, not
decoration. For the *forward* path and for *whole-change* rollback, the tool is
strong.

Where it is thin is exactly where production teams feel the most pain:

- **Selective rollback** (roll back one instance out of a multi-instance
  change) is the single biggest gap. Today revert is all-or-nothing per change
  request.
- **Cross-version re-apply** ("I made this edit on v24.3, we're on v24.4 now,
  apply the same edit") - the cherry-pick use case - has no first-class support.
- **Merge-conflict resolution** and **true 3-way merge** are detected/prevented
  but not *resolved* in-app; the tool hands genuine conflicts back to raw Git.
- **Attribution/history** is good but only on the local backend; the remote
  no-clone backend cannot serve a value timeline.

The scoring table in §9 lays out 13 real-world scenarios. Roughly: 6 Handled,
4 Partial, 3 Gap.

---

## 2. The forward workflow: draft -> submit -> approve -> publish

**Verdict: Handled, strong.**

The lifecycle is a real state machine (`change.State`):
`draft -> under_review -> approved -> published`, with `rejected` as the terminal
failure (`backend/internal/change/change.go:15-21`).

- **Draft** is per-user and lazily created. Each editor gets their own draft CR
  keyed by author, riding its own `feature/…` branch from the very first edit,
  so nobody is ever "editing on main" (`crstore.go:98-121`). Edits accumulate as
  `Item`s and `UpsertItem` preserves the *first observed* baseline value across
  successive edits of the same cell (`change.go:186-197`) - important later for
  honest diffs and reverts.

- **Submit** (`changeset.Submit`, `changeset.go:134-220`) does the real work:
  opens an isolated worktree on `feature/<slug>`, applies items in a deliberate
  order (structural instance changes -> whole-file edits -> value edits, so a new
  instance's folder exists before values land in it, `applyDraft:228-270`),
  writes surgically through `pathedit`/`writeback` (comments, key order, and
  unmanaged content preserved), makes **one commit** for the whole CR, pushes,
  and opens a PR when a provider is configured.

- **Approve** (`changeset.go:508-537`) records structured sign-offs. Policy gates
  are real: `RequireApproval`, `RequireSeparateApprover` (author cannot approve
  their own change), and `MinApprovals` (N distinct approvers). The zero-value
  policy is deliberately permissive so a single user can submit-and-publish; the
  API layer tightens it when login is enabled.

- **Publish** (`Merge`, `changeset.go:465-496`) merges the PR (provider) or does
  a local `--no-ff` merge mirroring one, then deletes the branch. Approval is
  enforced before publish when policy requires it.

**Attribution is first-class.** The commit carries the human as Git author, the
machine identity as committer + `Co-authored-by`, plus trailers
`Change-Request: #id`, `Reference:`, `Category:`, and `Changed-by:`
(`commitMessage:107-129`). The PR body renders a full change table
(`prBody:423-461`). This is exactly the diff a careful engineer would have
produced by hand, which is the whole premise.

**What a user experiences:** clean and legible. The gap here is minor - the
two-step "approved but not yet live" state is good governance but the UI should
make the "why is this still not live" obvious to a non-technical approver.

---

## 3. Rollback, by scope

This is where the interesting real-world nuance lives. There are four distinct
"undo" scopes, and Configer handles them very unevenly.

### 3a. Undo a *pending* edit (before submit)
**Verdict: Handled.** `revertValue` drops one staged item from the draft
(`values.go:336+`), and the whole draft can be discarded. Trivial, correct.

### 3b. Roll back an *entire published change*
**Verdict: Handled, and done the right way.** `revertChange`
(`api/revert.go:32-77`) stages the **inverse** of every item in a published CR
into a fresh draft, which then flows back through review -> approve -> publish.
No force-push, no history rewrite - the rollback is itself a reviewable,
attributed, forward commit. This is the correct Git-native model.

The inversion logic (`inverseItem:81-114`) is honest about what it can and
cannot reverse:
- value edits and file edits invert by swapping old/new;
- `update-instance` inverts only if prior metadata was captured;
- `reset`/`exclude` restore the prior value if one was recorded;
- `add-instance` inverts to `remove-instance`;
- **`remove-instance` cannot be inverted** (the folder and files are gone) - it
  is reported as *skipped* rather than guessed at. Correct and honest.

### 3c. Roll back **only one instance** out of a multi-instance change
**Verdict: GAP. This is the most important missing capability.**

The user's exact scenario: upgrade `prod-us-east`, `prod-eu`, and `prod-apac`
in one edit; `prod-apac`'s deploy fails; roll back **only** `prod-apac` and
leave the other two live.

Today `revertChange` iterates **all** `src.Items` with no instance filter
(`revert.go:54-65`). There is no `?instance=` or item-selection parameter. The
only workarounds are manual:
1. Open the grid, find the old value for that one cell, and re-edit it back by
   hand (requires the user to *know* the pre-change value), or
2. Use the parameter history/compare views to read the old value, then re-stage
   it manually.

Both defeat the "one-click, I trust the tool" promise. See §10 for the
recommended fix (a selective-revert item picker), which is a small, natural
extension of machinery that already exists.

### 3d. Roll a single cell back to a *specific historical commit's value*
**Verdict: Partial.** The value timeline (`parameterHistory`) *shows* the value
at each past commit and marks where it changed, but there is no "restore this
cell to the value it had at commit X" action. The information is there; the
one-click bridge from "I can see it" to "put it back" is not.

---

## 4. Who changed what, and when (attribution & history)

**Verdict: Handled on the local backend; Partial overall.**

Two history surfaces exist and they are good:

- **App-level history** (`GET /api/history`, `reads.go:286-297`): recent commits
  touching `.configer/`, newest first.

- **Per-cell value timeline + blame** (`GET /api/parameters/{id}/history?instance=`,
  `reads.go:406-484`). This is the strong one. It scopes the log to the *cell's
  actual backing files* (the parameter's base + instance bindings) plus
  `.configer` (`cellLogPaths:329-362`), materializes the project at each commit,
  resolves the effective value there, marks where the value actually **changed**,
  and computes a **blame**: the newest commit where the value changed - i.e. *who
  set the value it has now, and when* (`lastChange:469-483`). This is a
  genuinely nice answer to "who changed this and when."

**The limitation:** both endpoints return `supported: false` on any backend that
is not `"local"` (`reads.go:296, 482`). The remote no-clone (Git-data-API)
backend cannot serve a `git log`, so on that deployment the "who/when" question
has **no answer at all** in-app. For a hosted, multi-user deployment - precisely
where "who changed this?" matters most - the timeline goes dark. See §10.

---

## 5. Concurrency: multiple users, multiple edits

**Verdict: Handled for the common cases; Partial at the sharp edge.**

The design is thoughtful:

- **Per-owner drafts** mean two users editing simultaneously never share a draft
  or a branch; each has isolated `feature/…` work (`crstore.go:98-121`). Their
  value edits cannot clobber each other because each stages into its own owned
  draft and upserts (`etag.go:3-16`).

- **Server-side write serialization** via `writeMu` around every mutating handler
  (e.g. `values.go:283`, `reconcile.go:314`).

- **Optimistic concurrency for direct catalog writes** (parameter metadata, app
  identity, which commit straight to the working branch). Every catalog READ
  returns the working HEAD SHA as an `ETag`; a WRITE must echo it as `If-Match`,
  or it is refused with `428` (no token) / `412` (stale) and told to reload
  (`etag.go:43-72`). Deliberately coarse but safe.

- **Staleness guard at apply time** (`ensureNotStale`, `changeset.go:343-361`):
  if the live value at a binding no longer matches the baseline the user staged
  against (`it.Old`), someone changed it on Git in between, and submitting would
  silently overwrite them. The submit is refused with a conflict ("someone
  changed it on Git in the meantime; reload and re-stage"). This is real
  lost-update protection.

**The sharp edge (Partial):** two users edit the *same cell* in *separate
drafts*. User A submits and publishes. User B's draft still carries the same-cell
edit. On submit, `ensureNotStale` catches it *if* B's baseline no longer matches
- good. But if both branches are open PRs touching the same file and both reach
merge, the **second merge hits a raw Git conflict** with no in-app resolution
(see §7). The detection is solid; the *resolution* is handed back to Git.

---

## 6. External drift: edits made directly on Git

**Verdict: Handled.** This is a strength and it matters, because Configer's whole
thesis is "Git is still the source of truth; we never gate it."

- A **background sync loop** polls origin and fast-forwards the working tree /
  refreshes the read cache, so external commits appear in the grid with no user
  action, and reports ahead/behind and `upstreamGone` (`sync.go:38-107`).

- **Reconcile / findings** (`reconcile.go:45-195`) diffs the last acknowledged
  SHA against HEAD and classifies what happened outside the tool: new config
  files (with a candidate count), managed files changed / deleted / renamed
  directly on Git, and whole new folders (a possible new vendor version drop).
  Each finding is a human sentence with a suggested action, and the delete case
  has a one-click "retire the affected parameters" resolution
  (`retireFile:458-505`). Force-pushed baselines are handled by re-baselining
  rather than erroring forever (`reconcile.go:62-66`).

This is a mature answer to "the world changes underneath you."

---

## 7. The advanced operations: 3-way merge, cherry-pick, cross-version re-apply

This is where production teams' hardest scenarios live, and where Configer is
weakest. Be clear-eyed here.

### 7a. True 3-way merge
**Verdict: Partial (really: detection only).** `diff/diff.go:3` *advertises*
"parameter-level 3-way merge during change requests," but no 3-way merge exists
in the code. What exists is:
- a **semantic 2-way compare** (`CompareAcross`, `diff.go:83-135`) - base vs.
  incoming, added/removed/modified per parameter, across two Git refs; and
- the **2-way staleness guard** (`ensureNotStale`) which *detects* a conflicting
  concurrent change and refuses.

There is no common-ancestor 3-way reconciliation and no UI to resolve
"they changed X to A, you changed X to B, the base was C." The comment
overpromises relative to the implementation.

### 7b. Cherry-pick / cross-version re-apply
**Verdict: GAP.** The user's scenario - "a parameter was edited on the base
version; we now have a new version; apply the same previous edits to it" - has
no first-class path. There is no cherry-pick concept, no "re-apply this change
onto another branch/version," no "port these edits forward." A user would have
to read the old change and manually re-stage each edit against the new version.
Given that `versionIntroduced`/`softwareVersion` are already model concepts, and
that `Item` already captures old/new per cell, this is a natural feature the tool
is architecturally *ready* for but does not yet offer (§10).

### 7c. Git-level merge conflicts
**Verdict: GAP (in-app).** When two feature branches touch the same file,
`MergeBranch` / provider `Merge` will fail at publish time. There is no in-app
conflict-resolution view; the user is dropped to raw Git. For a tool whose
audience explicitly includes non-Git-fluent approvers, this is a hard cliff. The
mitigations (per-owner branches, surgical single-key edits that reduce textual
overlap, staleness guard) make conflicts *rarer*, but when one happens the tool
has nothing to say.

---

## 8. How the real workflow actually plays out (worked scenarios)

**Scenario A - "Upgrade the whole prod fleet's memory limit, one instance's
deploy fails."**
- Upgrade: `bulkStageValue` (`values.go:242-334`) stages the same parameter
  across many instances in one draft, one lock. **Clean.**
- Submit -> approve -> publish: **clean.**
- Roll back the one failed instance: **you can't, cleanly.** `revertChange`
  reverts all three. You must hand-edit the failed cell back, if you know its old
  value. **This is the scenario the tool most needs to nail and currently
  doesn't.**

**Scenario B - "Which change set prod's admin port to 8443, and who approved
it?"**
- Local backend: `parameterHistory` gives the value timeline + blame + author;
  the CR carries structured `Approvals` and comments. **Answered well.**
- Remote no-clone backend: timeline is `unsupported`. **Unanswered.**

**Scenario C - "Someone hotfixed a value directly on GitHub."**
- Sync loop surfaces it in the grid; findings classifies it as
  `file_changed`/`file_deleted` with a suggested action; a later staged edit
  against the stale value is refused by `ensureNotStale`. **Handled end to end.**

**Scenario D - "We tuned three params on v24.3; v24.4 is out; apply the same
tuning."**
- No cherry-pick / re-apply. **Manual re-entry.** Gap.

---

## 9. Scorecard

| # | Real-world scenario | Verdict | Where it lives |
|---|---|---|---|
| 1 | Draft -> submit -> approve -> publish | **Handled** | `changeset.go` |
| 2 | Bulk-edit N instances in one change | **Handled** | `values.go:242` |
| 3 | Roll back an entire published change (no force-push) | **Handled** | `revert.go` |
| 4 | Roll back **one instance** from a multi-instance change | **Gap** | `revert.go:54` |
| 5 | Who/when/what changed a parameter (local) | **Handled** | `reads.go:406` |
| 5b | Same, on remote no-clone backend | **Gap** | `reads.go:482` |
| 6 | Restore a cell to a specific historical value | **Partial** | `reads.go:406` |
| 7 | Concurrent editors, separate drafts | **Handled** | `crstore.go`, `etag.go` |
| 8 | Lost-update / stale-write protection | **Handled** | `changeset.go:343` |
| 9 | External drift / direct-on-Git edits | **Handled** | `sync.go`, `reconcile.go` |
| 10 | True 3-way merge (common-ancestor resolve) | **Partial** | `diff.go` (2-way only) |
| 11 | Cherry-pick / re-apply edits across versions | **Gap** | not implemented |
| 12 | In-app merge-conflict resolution | **Gap** | delegated to raw Git |
| 13 | Approval governance (SoD, min approvals, audit) | **Handled** | `changeset.go:508` |

---

## 10. Recommendations, in priority order

**P0 - Selective (per-instance / per-item) revert.** The highest-value, lowest-
cost fix. Extend `revertChange` to accept a filter (`{instances:[…]}` or
`{items:[{paramId,instance}]}`) and invert only those items. The machinery -
`inverseItem`, staged inverse into a reviewable draft - already exists; this is a
loop-filter plus a request field. In the UI, the published-change view already
lists items in a table (`prBody`/`ChangeItemsTable`); add checkboxes and a
"Revert selected" button next to the existing "Revert" (`ApprovalsView.tsx:520`).
This turns Scenario A from "impossible cleanly" into one click.

**P1 - Cross-version re-apply ("port these edits").** Add a "re-apply this
change onto <instance/version>" action that reads a source CR's items and
re-stages them (old/new preserved) against a chosen target, running each through
`ensureNotStale` + `validate` so anything that no longer fits surfaces as a
conflict for review rather than applying blindly. This is Configer's semantic
answer to cherry-pick, and it fits the model far better than raw
`git cherry-pick` because it is *parameter-aware*.

**P2 - "Restore to this value" from the timeline.** In `parameterHistory`, each
entry already knows the value at that commit. Add a per-entry "restore this
value" that stages a normal `set` item with `Old` = current, `New` = historical.
Closes scenario 6 and complements P0.

**P3 - History on the remote backend.** The no-clone backend can serve commit
history via the GitHub commits API without cloning. Implementing `Log` there
(even if capped/paged) removes the single worst hole in the hosted-deployment
story (scenario 5b). If a full timeline is too costly, at least surface
`lastChange` (blame) via a single commits-for-path call.

**P4 - In-app conflict presentation.** You will not build a full 3-way merge
editor soon, and you may not need to. The minimum viable step: when a publish
merge fails on conflict, catch it and show a semantic, parameter-level view
("both changes touch `net-admin-port` on `prod-eu`: theirs=8443, yours=8080")
using the compare machinery you already have, with a "take theirs / take mine /
edit" choice that re-stages the resolution as a normal draft item. This keeps
non-Git users inside the tool. Also: **fix the `diff.go:3` comment** so it stops
claiming a 3-way merge that does not exist.

**P5 - Make the "approved, not yet live" state legible.** Small UX: on the
change and dashboard views, distinguish `approved` from `published` with an
explicit "approved, awaiting publish" affordance so an accountable approver
understands why a signed-off change is not yet in production.

---

## 11. Bottom line

Configer is a genuinely Git-native config tool with an honest write-back model,
real attribution, and a real review gate. Its forward workflow and its
whole-change rollback are production-grade. Its drift handling and concurrency
protections are better than most tools in this space.

Its gaps cluster around **selective, surgical recovery** - the exact operations a
fleet operator needs when a *partial* rollout goes wrong: revert one instance,
port an edit to a new version, resolve a conflict without leaving the tool. None
of these require abandoning the architecture; every one of them is a natural
extension of the `Item`/`inverseItem`/`compare` primitives already present. The
P0 selective-revert fix alone would close the most painful real-world gap and is
a small change. Ship that first.
