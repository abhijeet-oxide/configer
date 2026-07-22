# Configer - Usability & Functionality Evaluation

**Method:** I deployed Configer locally (backend `:8080` + frontend `:5173`),
pointed it at a **brand-new, un-onboarded repo** (a copy of the `helm-umbrella`
sample, git-initialized so nothing was pre-configured), and drove the **real
browser UI** end to end with Playwright - no tutorial, no docs-first reading of
the flow. I wore two hats: a **git/GitOps-naive editor** making a change, and an
**admin/approver** validating, approving, publishing, and checking that the right
bytes (and only those) changed in the real files. I then probed the production
scenarios you named: fresh deployment, upgrade, patch, reject, and rollback.

**Bottom line:** The core promise is **real and it works**. I onboarded an app,
edited a value, submitted it, approved it, published it, and confirmed the exact
one-line surgical change landed in the real config file on `master` - with
comments and blank lines preserved byte-for-byte. The onboarding wizard, the
grid, Compare, and the in-app review/approve flow are genuinely good. But there
are **three functional bugs that would bite a real user on day one**, and
**rollback - the scenario you care most about - is the weakest part of the
product.** Details below, most severe first.

---

## 1. What works well (keep these; they're the moat)

- **Onboarding wizard is the best part of the product.** Clear 4-step stepper
  (Layout -> Instances -> Parameters -> Initialize), it auto-detected the layout
  ("Per-instance folders under environments/"), found 21 parameters / 4
  instances, and - crucially - reassured me at every step that *"Nothing is
  written until the final step."* The final commit added **only** `.configer/`
  (verified: `3 files changed, 372 insertions`, zero config files touched). A
  naive user is never scared here.
- **Surgical write-back is not marketing - it's true.** My edit produced a git
  diff of exactly `-  tag: "2.9.0-rc3"` / `+  tag: "2.9.0"`. `cat -A` confirmed
  every blank line and the top comment survived byte-for-byte. This is the
  single most trust-building thing the tool does.
- **The grid mental model lands immediately.** Rows = parameters, columns =
  instances, dedup badges ("2 files"), provenance chips (base / instance /
  global), a secret lock icon, typed editors (toggles, dropdowns, chips). I
  understood it without help.
- **Compare** is a real strength: parameter-level semantic diff, color-coded,
  a "14 changes" meter, inline/side-by-side, and comparison **across git refs**.
- **In-app review/approval** looks and feels like a PR (Approve / Request
  changes / Reject, comments, reviewers, the value diff) - a genuine reason to
  use this over hand-editing.
- **Instance scaffolding works:** cloning `prod-us` into a new `prod-ap` region
  staged a structural change and, on publish, wrote a real
  `environments/prod-ap/` folder copied from the source. Verified on disk.
- **Draft-stage revert is excellent** (see §4).

**Verified end-to-end chain:** onboard -> edit -> validate -> submit CR ->
approve -> publish -> **real file on `master` changed** (`dev/values.yaml` now
`tag: "2.9.0"`, via a proper merge commit with `Change-Request:`/`Changed-by:`
trailers). The spine is solid.

---

## 2. Critical bugs (functional - fix before a demo)

### BUG-1 (P0, blocking): the hostname validator rejects valid FQDNs
The moment I onboarded, **every `ingress.host` in the fleet lit up red** -
`platform.example.com`, `eu.platform.example.com`, etc. - with
*"Hostname label: doesn't match the required format, for example web-01."*
Then, as a user, I tried to set a real host and **the tool refused to save it**:

- `app.dev.example.com` -> **HTTP 422 rejected**
- `web-01` (a single label, which is *wrong* for an ingress host) -> **200 OK accepted**

So Configer **cannot store the most common real value for an ingress host** (a
dotted FQDN) and **happily accepts a nonsense one.** Root cause is a real code
bug, not data:
- `discovery/schema.go:197` maps JSON-Schema `format: hostname` to the preset
  `"hostname"`.
- That preset (`validate/presets.go:44-50`) is a **single-label** rule -
  `^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$`, example `web-01`, no dots.
- Ironically the type-based validator `validate/validate.go:250` already has an
  FQDN-correct regex (`(\.[a-z0-9]...)*`). The right one exists; the wrong one
  is wired up.

**Impact:** blocks legitimate production edits, and floods the health dashboard
with false alarms (5 of the 6 "failing validation" items in my run were this
bug). **Fix:** map `format: hostname` to the FQDN-aware type (or the JSON-Schema
`hostname` format, which per spec allows dots), or broaden the preset pattern.

### BUG-2 (P0): the write validator and the grid validator disagree
`PUT /api/values` **accepted** `web-01` (200, staged into the draft), but the
grid then rendered that same cell **`valid:false`** with a red border, and the
"Review your changes" modal let me **submit it anyway with no warning.** A tool
that lets you save a value and then tells you it's invalid - and still lets you
ship it - destroys confidence in the validation layer. The write path and the
read/grid path must run identical rules, and the submit modal must block (or at
least warn) on any grid-invalid cell in the changeset.

### BUG-3 (P1): Configer reports its OWN published commits as external "drift"
After I published two change requests through the tool, the **Repository
changes** inbox showed: *"environments/dev/values.yaml - A managed file was
changed directly on Git,"* listing all 15 params. It wasn't changed directly -
**Configer published it.** The reconcile baseline ("last seen commit") is stuck
at the onboarding commit `b919cbe` and never advances when the tool merges, so
it diffs `b919cbe -> HEAD` and calls the tool's own work external drift. Worse,
the same view **missed** the newly-added `prod-ap/` folder ("New files 0"). An
admin reading "changed directly on Git" will think someone bypassed the tool.
**Fix:** advance the last-seen SHA on every successful publish/merge; label
Configer-authored commits as such.

---

## 3. Rollback & revertability - the biggest UX gap

You specifically asked: *an instance was updated and now has an issue - how easy
is it to roll back?* Answer today: **not easy, and not guided.**

- **Pre-submit (draft) revert is great.** Per-cell inline undo arrow, a per-item
  trash icon in the review modal, and a whole-draft **Discard**. I made a
  mistake (`web-01`), clicked the trash, and it was gone. 
- **Post-publish revert does not exist.** I searched a published CR for
  *Revert / Rollback / Undo / Restore* - **none are present.** A published CR is
  a dead end. The only path back is to **manually re-type the old value and push
  a brand-new change request** (forward-fix). There is no "revert this change
  request," no git-revert integration, no "restore instance to last-good."
- **You aren't even told what to roll back TO.** The previous value isn't shown
  at edit time, and the **Audit log records "Edited a configuration value" with
  no old->new values.** To learn the last-good value you must use Compare-across-
  refs or drop to `git`. For a naive user mid-incident, that's a wall.

**Recommendation (high value):** add a one-click **"Revert this change"** on any
published CR that stages the inverse edit as a new draft CR (so it still flows
through review), and show **old -> new** in both the Audit log and the cell
details/history. A "Restore instance to commit X" would make the
patch/rollback story a headline feature instead of a gap.

---

## 4. Validation UX (beyond the bugs)

- Inline, typed, immediate editors (toggle/dropdown/chips/number clamp) - good.
- **Error messages are inconsistent and often unhelpful.** The hostname error
  gives an example (`web-01`), but `image.tag` just says *"doesn't match the
  required format"* with **no hint of the expected `X.Y.Z` shape.** A naive user
  is stuck guessing. Every message should state the expected format/example.
- **The health dashboard cries wolf.** "Configuration health: 6 to fix" on a
  freshly onboarded repo, where 5/6 are BUG-1 false positives. First impression
  for an admin is "this repo is broken," when the validator is.
- The footer **"invalid" count looked stale** right after I fixed an invalid
  value in the draft (it tracks committed state, not the draft-applied state),
  which briefly contradicts the green cell you're looking at.

---

## 5. Trust & correctness papercuts

- **Provenance can mislead.** Editing *dev's* `ingress.host` (dev doesn't
  override it) showed the details panel sourcing `charts/platform/values.yaml`
  (the shared **base**), yet the actual staged write correctly targeted
  `environments/dev/values.yaml`. The provenance shown != where the pending edit
  goes. For a "which file wins" tool, that's the one place it must be exact.
- **The in-app diff preview is misleading even though the commit is clean.** The
  "View exact file changes" preview rendered a confusing `+3 -5` and appeared to
  strip blank lines - but the actual commit preserved them perfectly. So the
  *real write is right; the preview lies.* Fix the diff component so reviewers
  trust what they approve.
- **Branch name the UI promises != what it does.** The submit modal said
  *"saves your edits to branch `configer/cr-1`"*; the branch actually created was
  `feature/upgrade-dev-image-to-release-2-9-0`; the docs say `configer/cr-<n>`.
  Three different stories about what the tool does to your Git.

---

## 6. Audit / attribution

- Human-readable primary column ("Published change request #1", "Initialized the
  application") - nice.
- But it **leaks raw API calls** underneath (`POST /changes/1/merge`,
  `DELETE /values`, `PUT /values`) - which contradicts the project's own
  "plain words, never git jargon" rule.
- **Attribution is inconsistent:** value edits are logged as **`anonymous`**
  while submit/approve/init are `demo-user`. In an audit trail you literally
  cannot tell **who changed a value** - the most important thing to audit.
- Read-only discovery scans spam the log ("Created discover" x5 from me just
  opening the wizard). No old->new values recorded (see §3).

---

## 7. First-run mental model & smaller UI/UX/a11y notes

- **Two competing "setup" prompts at once.** On landing I got a *"Welcome to
  Configer - Set it up"* modal (personalization/theme) **and** a
  *"fresh-repo - Setup incomplete - Finish setup"* card (the real onboarding).
  Same verb, different meaning. A naive user can't tell which one actually
  configures their repo. Rename the personalization one (e.g. "Personalize")
  or defer it until after the repo is onboarded.
- **Publish has a name collision and a two-step confirm that's easy to fumble.**
  The "Published" *tab* and the "Publish" *action button* share a name; I (and a
  real user) can click the tab thinking it's the action. My first publish
  silently did nothing because of this. Disambiguate the labels.
- **Accessibility:** the per-item delete buttons in the review modal have **no
  `aria-label`** (empty text, no role name) - unusable with a screen reader.
- **Git jargon surfaces to users** despite the convention: branch names,
  `master`, "Target: master", "merge" appear in user-facing surfaces.
- Console shows an Ant Design deprecation warning (`destroyOnClose`) - harmless
  but worth clearing.

---

## 8. Instance clone gotchas (fresh-deployment scenario)

Cloning `prod-us` -> `prod-ap` copied the folder verbatim, which means the new
instance shipped with:
- the **source's header comment** still saying `# prod-us overrides...`, and
- `ingress.host: us.platform.example.com` (the *source region's* host).

So a new region is born pointing at the old region's hostname - and because of
**BUG-1 you can't correct that host in the grid** (a real FQDN is rejected).
Consider prompting for per-instance overrides (host, region) during clone, and
rewriting obvious self-references/comments the way the kustomize/kpt adapters
reportedly do.

---

## 9. Prioritized fix list

| Pri | Item | Why |
|-----|------|-----|
| **P0** | BUG-1 FQDN hostname validation (`schema.go:197` -> single-label preset) | Blocks real edits; floods health with false alarms |
| **P0** | BUG-2 write-vs-grid validation parity + block invalid submits | You can save a value the tool then calls invalid |
| **P1** | BUG-3 advance reconcile baseline on publish; label own commits | Tool reports its own work as external drift |
| **P1** | Post-publish **Revert** (inverse CR) + old->new in Audit/history | Makes rollback/patch a feature, not a gap |
| **P1** | Audit attribution (real author, not `anonymous`); record values | An audit trail must say who changed what |
| **P2** | Specific validation messages (expected format + example) | Naive users get unstuck |
| **P2** | Fix the in-app diff preview (`+3/-5`, blank-line collapse) | Reviewers must trust what they approve |
| **P2** | Reconcile branch-name copy across modal/docs/actual | Say what you'll do to Git, do what you say |
| **P2** | Disambiguate Publish tab vs action; add aria-labels; de-jargon audit | Polish & a11y |
| **P2** | Clone: prompt for host/region overrides; rewrite stale comments | New deployments ship wrong host today |

---

## 10. Answering your specific scenarios

- **Fresh deployment:** Clone-an-instance works and scaffolds a real folder.
  Rough edges: stale source comment/host, and you can't fix the host (BUG-1).
- **Upgrade:** Smooth. Edit `image.tag`, review, submit, approve, publish -
  landed cleanly and surgically. This is the tool at its best.
- **Patch:** Same smooth path for a single-value change.
- **Reject a mistake (pre-publish):** Excellent - per-cell undo, per-item trash,
  whole-draft Discard, and a CR-level Reject in review. Easy and obvious.
- **Rollback (post-publish incident):** **Weakest scenario.** No revert button,
  no restore, no old->new history; forward-fix by hand is the only route and the
  tool doesn't tell you the last-good value. This is where a naive user gets
  stranded during an incident - and it's the highest-leverage thing to improve.
