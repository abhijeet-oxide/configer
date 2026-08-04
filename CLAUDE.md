# Configer - contributor guide

Configer is a **write-back-native** GitOps configuration UI: it renders an
existing repository's config as a parameter×instance grid and edits the
repository's OWN files surgically. `.configer/` holds metadata only - never
values, never generated artifacts. Every UI action is an ordinary Git
operation (draft → branch → commit → PR → merge).

## Commands

```bash
make install        # go modules + npm + git hooks (first time)
make dev            # backend :8080 (serves ./sample-repo) + frontend :5173
make test           # go test ./... + tsc --noEmit
make lint           # go vet + golangci-lint + eslint
make build          # backend binary + frontend dist
./scripts/smoke.sh  # end-to-end: onboard fixture, edit, submit, assert branch diff
make functional-test # scanner functional + scale suite over sample-repos/ (backend + API)
make quality        # the quality platform, incremental against origin/main
make quality-local  # the fast loop (< 30s): formatting, types, vet
make quality-doctor # which analyzers and tools are available here
```

`make install` also points `core.hooksPath` at `scripts/hooks`, whose
pre-commit regenerates the OpenAPI spec whenever `backend/internal/api/*.go`
changes and stages it in the same commit - the spec is generated AND committed
(the backend serves it at `/api/docs`), so it must travel with the code. CI
keeps `make docs-check` as the safety net and uploads the corrected files.

`sample-repos/` is a corpus of realistic GitOps repos (Helm umbrella, kustomize
base+overlays, kpt packages, raw multi-cluster K8s, telco RAN) with no
`.configer/`; `make functional-test` onboards each and asserts detection,
dedup, envelope filtering, schema validation and write-back, plus a synthetic
large-fleet scale check. The Go side is build-tagged (`go test -tags functional
./internal/discovery/...`); the API side drives `POST /api/discover` from Node.

Backend alone: `cd backend && CONFIGER_REPO=../sample-repo go run ./cmd/configer`.
Verification bar for any change: `go vet`, `golangci-lint run`, `go test ./...`,
`npx tsc --noEmit`, `npx eslint src`, and the smoke script all green.

**Driving the UI (browser tests, screenshots):** append `?welcome=skip` to the
first URL you open. The first-run tour is a modal over everything, and clicking
it away in every script is how a test ends up asserting against a dialog. The
parameter is read once at boot and recorded on the device, so it holds for the
whole session even though the router cleans it out of the address bar;
`?welcome=show` forces the tour back for a screenshot of it. The flag underneath
is `localStorage["configer.welcomed.v1"]`, so a Playwright `addInitScript` or a
saved `storageState` does the same thing without a URL.

## Continuous Quality Platform (`quality/`, docs in `docs/cqp/`)

`cq` is a SECOND Go module and never a dependency of the shipped backend. It
orchestrates existing open source tools rather than replacing them: it works out
which analyzers a change can possibly affect, runs them in parallel with a
content-addressed cache, normalizes SARIF / JUnit / LCOV / CycloneDX / Lighthouse
/ k6 / benchstat into one vocabulary, deduplicates across tools, applies the
quality budgets and writes one report for people, pipelines and AI agents.

Two rules govern it, and they are what keep the catalog cheap:

- **A TOOL is data, a FORMAT is code.** Adding an analyzer is one YAML manifest
  in `quality/internal/catalog/manifests/` (shipped) or `.cq-analyzers/` (this
  repository's own): no Go, no registration, no rebuild. Only a new output
  format earns a normalizer. 19 normalizers carry 36 analyzers, because SARIF
  alone carries eight tools.
- **A missing precondition is a STATE.** A tool that is not installed is an
  explained skip, never a failure and never a silent pass. A regression budget
  with no baseline reports `skip`, because reporting `pass` would quietly
  disable every gate on every new branch.

Blocking budgets are REGRESSION budgets (`bundle-growth`, `api-call-growth`,
`coverage-floor`, latency and benchmark regressions), measured against the merge
base. Absolute budgets ship advisory, except where zero is genuinely the only
acceptable number: secrets, critical security findings, console errors, data
races, goroutine leaks, breaking API changes. Edit `cq.yaml` to change any of it;
never gate on the score, which exists only for the trend line.

## Architecture (backend, `backend/internal/`)

**The edit spine - every write goes through here:**
- `pathedit` - THE single engine for reading/surgically editing YAML/JSON/XML
  documents. Comment-preserving yaml.Node edits; order-preserving JSON
  emission; XML via etree. Paths: dotted (`$.a.b`, `servers[2]`,
  `rules[name=ssh].port`) or XPath for XML. A key the dotted form cannot carry
  (one containing `.` or brackets, or empty) is quoted:
  `$.value['query.dependencies'].x` - build one with `pathedit.JoinKey`, never
  by string concatenation, or the path silently resolves to nothing and writes
  a nested block on top of the real key. Never add a second path engine.
  `pathedit.Segments(format, path)` is the matching read: the NAME STEPS a path
  spells, for YAML/JSON and XPath alike. Every producer of a parameter name goes
  through it (`parsers.nameFromPath`, `xmlName`, discovery's folded lists), and
  `grid` hands the steps to the UI as `nameSegments` whenever splitting the name
  on `.` would land in the wrong places - because it silently does: a key that
  itself contains a dot made the tree nest two folders the file never had.
- `writeback` - file-level wrapper: read file, pathedit, write file.
- `change` / `changeset` / `crstore` - the change-request lifecycle
  (Draft→UnderReview→Approved→Published). `changeset.Submit` takes a
  `SubmitRequest`, opens an isolated worktree, applies draft items (structural
  instance changes → direct file edits → value edits), commits with a
  `Changed-by:` trailer, pushes, opens a GitHub PR.
- **Editing a file is also a CATALOG change.** A direct file edit that
  introduces settings nothing manages stages one `add-parameter` item per new
  setting beside the `edit-file` item (`api.addedParameters`, judged against the
  COMMITTED bytes and filtered through `discovery.Tunable` so a file edit and an
  import propose exactly the same things). They preview as `pendingAdd` rows and
  publish as `.configer/parameters.yaml` entries in the same commit - otherwise
  new settings are bytes in a diff, absent from the grid and unnamed in the
  review, which is how "edited directly" became the whole story of a change that
  added four networks.
- **A branch says what the change is**: `<category>/<owner>/cr-<n>-<slug>`
  (owner omitted when there is no login, i.e. single-user; category is the
  change type - hotfix/feature/bugfix/… - and `change` when none was picked).
  A suffix is added ONLY when the ref is really taken (`branchFor` asks
  `Backend.BranchExists`). Two changes that are both still OPEN may not share a
  title: `FindNameConflict` refuses it at submit, and
  `GET /api/changes/name-check` answers the same question while the user types.
  A title held by a published or rejected change is reusable.
- **A draft is not a change request yet.** `ChangeRequest.ID` is the store's
  internal key, allocated when a draft first exists; `Number` is the CR number
  people say out loud and is handed out at SUBMIT (`nextNumber`, one past the
  highest issued). So discarded drafts leave no holes in the sequence, and a
  draft has no number and no branch until it is sent for review - the UI says
  "Your draft" and "branch created when you submit" rather than inventing
  either. Undoing a draft's last item deletes the draft (`dropEmptyDraft`).
- `crstore` is an INTERFACE with two implementations. `FileStore` keeps a JSON
  file beside the repo (no dependencies, right for one person); `SQLStore`
  keeps a row per change request in the platform database (a write touches one
  row, a read-modify-write is a transaction, two processes share it).
  `api.crStore` picks: Postgres → SQL, embedded SQLite → file, and
  `CONFIGER_CR_STORE=sql|file` overrides. An upgrade carries an existing file
  across once via `SQLStore.Import`. Either way this is WORKFLOW state only -
  configuration truth stays in Git. **Both stores hand out COPIES**: editing a
  change request you were given persists nothing, `Update` is the only way in.

**The model:**
- `model` - `Parameter` (metadata + `Bindings []Binding`), `Instance`
  (metadata + `Folder`), `Application`. A Binding is `{File, Path, Format,
  Layer}`; `File` may template `{folder}`/`{instance}`. Layers: `base`
  (shared file, one edit affects all) < `instance` (own folder). A
  deduplicated parameter has N bindings; edits fan out to all.
- `project` - loads `.configer/{application,parameters,instances,ignore}.yaml`.
- `resolver` - effective cell value = default → base bindings → instance
  bindings, reading the REAL files via pathedit; reports which file won.
- `grid` - builds the matrix (+ `ApplyDraft` previews pending items,
  including draft instance columns).
- `validate` - types, preset rules, regex/min-max; gates every write (422).

**External sources (plugin-based):**
- `plugin` - THE extension registry. `IngestParser` (file -> candidates),
  `SchemaImporter`, and `SourceProvider` (external system -> key/value pairs)
  all register here; add an extension point, never a second registry.
- `sources` - built-in `SourceProvider` plugins: `git` (read a config file/
  folder in another repo, no clone for github via `remoterepo`, temp clone
  otherwise, parsed through the same `parsers`) and `vault` (HashiCorp Vault
  KV v2, experimental). A source exposes `SourceKV` pairs; a secret source
  masks values and emits a reference (`${vault:mount/path#key}`) written back
  in place of the plaintext. Add a new source kind = one file here + one line
  in `register.go`.
- Sources are defined in `.configer/sources.yaml` (connection metadata only,
  never credentials - tokens resolve server-side from `GITHUB_TOKEN`/
  `VAULT_TOKEN`). A parameter's `source:` field maps it to a source key; the
  upstream value surfaces as an "incoming change" (`api/sources.go`) the
  reviewer accepts into the draft (an ordinary `ActionSet` item), never applied
  silently. Fetched values cache in the CR store (`sourceSnapshot:` Meta), so
  the grid never blocks on a source's network call.

**Repo interpretation:**
- `layout` - Adapter per convention: `kpt`, `kustomize`, `plainfolders`
  (fallback). Detect / discover instances from folders / scaffold new
  instance folders. Add new conventions here.
- `discovery` - onboarding proposal: scan (via `ingest`+`parsers`), fold
  lists, dedup same setting across files/instances into one multi-binding
  parameter, unify kustomize base+patch pairs, attach JSON-Schema validation
  (`discovery/schema.go`), filter structural noise (kustomization.yaml,
  Kptfile, apiVersion/kind).

**Git plumbing:** `gitengine` (git CLI), `repobackend` (local worktree vs
GitHub Git-data-API no-clone - see `git_remote_clone.md`, that mode is
unfinished and has no UI), `remoterepo`, `provider` (GitHub PRs),
`api/sync` (poll fetch+ff), `api/reconcile` (external-commit findings).

Clones are **partial** (`--filter=blob:none`): all commits, trees and branches,
file contents fetched on demand. Never make them SHALLOW - `--depth` fetches one
branch and one commit, which silently kills compare, history, the timeline,
parameter history and restore-from-ref. `CONFIGER_FULL_CLONE=1` opts out for a
deployment that would rather not depend on the host being reachable.

**Statelessness:** a pod holds nothing it needs to survive. Applications open on
FIRST USE (`api/lazyopen.go`), never at boot - `NewHub` returns immediately and a
background warmer opens the rest, so a working copy is a cache: present and
startup is instant, absent and it is rebuilt. Readiness never waits on a
repository. The registry lives in the platform DB (`workspace.SQLRegistry`,
importing an existing `workspace.json` once), so replicas see the same
applications. Never add per-pod state that a restart cannot rebuild, and never
put an application open on the startup path.

**Platform (optional, off without OAuth env):** `store` (SQLite default /
Postgres via DATABASE_URL: users, sessions, app_members, audit_events,
workspace_repos, change_requests), `auth` (GitHub OAuth, cookie sessions),
`api/platform.go` (role enforcement: viewer < editor < approver, merge is
approver-gated; members endpoints admin-only; audit trail). Configuration data
NEVER goes in the DB - only workflow and operational state.

**HTTP:** `api/hub.go` (workspace: /api/repos/{id}/… + auth + dispatch),
per-repo handlers split by resource (`reads.go`, `values.go`,
`parameters.go`, `instances.go`, `changes.go`, `files.go`, `onboarding.go`,
`reconcile.go`, `helpers.go`).

**Concurrency (one application, many editors):** ONE working copy per
application, shared by everyone - never one per user. Two locks, in `locks.go`:
`treeMu` for the working tree and the git plumbing over it (catalog commits,
sync, merge, submit, reject), and a per-owner draft lock for read-modify-write
sequences on the change-request store. A handler needing both takes `treeMu`
first. Never reach for a single lock again: staging a cell edit must not queue
behind a colleague's push.

**Reads (`treecache.go`):** never call `project.Load` or build a resolver
directly in a handler - use `s.load()`, `s.resolve(p)` and `s.buildGrid(p)`.
They memoize the parsed project and parsed configuration files for as long as
the files are unchanged, which is what makes a grid over a large estate cheap
with several people reading it at once. Invalidation is automatic and needs no
cooperation: each file is revalidated by its own stat, and releasing `treeMu`
bumps a generation that drops the cache outright. A cached project is SHARED
and read-only. Anything rooted outside the working tree (a materialized ref, a
timeline snapshot) parses for itself.

## Architecture (frontend, `frontend/src/`)

React 18 + TS strict + Vite + Ant Design 5 + react-query (server state) +
zustand (`store.ts`, UI state with URL deep-links `?app=&view=&param=&inst=`).
Hand-rolled section router in `App.tsx` (deliberate - no router lib).
`api.ts` is the typed client and shared helpers (`bindingsOf`,
`expandBinding`, `structuralLabel`). Theming: `theme.ts` tokens through
`ConfigProvider` in `main.tsx` - never hardcode hex colors; use
`envHex`/`semantic`. Key views: `ParameterGrid` (grid + typed editors),
`FilesView`+`MonacoFileView` (file mode over real files, saves via
`PUT /api/files/draft`), `OnboardingWizard` (discover→init),
`InstancesView`, `SourceControlPanel`/`SubmitChangesButton` (the draft),
`ComparePanel`, `WorkspaceView`, `EvolutionTimeline` (history: `ChangeGraph`,
the vertical branch picture, or `GraphRail`'s dense commit list).

**One control per question.** "Which instances am I looking at, in what order,
and am I reading one on its own" is ONE question, so it has ONE control:
`InstancePicker`, the dropdown the grid's toolbar opens. A tick gives an
instance a column, a drag gives it a position, the row's own name opens it as a
single SHEET (`viewInstance` - a different presentation, not a filter), and the
environment chips are quick selections OVER those ticks, never a mode of their
own. There is no environment filter and no second column manager: `hidden` in
the per-application `colLayout` is the only state that answers "which
instances", however the user chose it. The gear beside it holds the editor's
SETTINGS (columns, density, row filters); a "⋮" said "more actions", which
those are not.

**The history picture (`ChangeGraph`)** draws the LIFECYCLE OF A CHANGE, not
git internals - the reader is an approver, not a platform engineer. Time runs
left to right; every branch that persists (the trunk plus each standing
environment branch - `prod`, `lab`, `sandbox`, … - see `api.reservedBranches`)
is a horizontal lane with its name on a pill STUCK to the left edge of the
scroller (`.cf-lane-names`), because the picture opens scrolled to the newest
end - the page says "newest first" and the graph must not open on last year.
A change request is drawn as a PATH, not an annotation: a thick Bézier leaves
the exact commit dot it forked from, docks flat into the left edge of its card,
and leaves the right edge - curving back into a lane only when it actually
merged (which may be a different lane than it left).

Two rules keep it legible and neither may be relaxed:

- **Cards outrank lines.** A card carries a monochrome type mark
  (hotfix/feature/bugfix/security/maintenance/change request - shape and label
  carry the type, `TYPE_MARK`, and it is shown even on a rejected change: what
  kind of thing was turned down is the point), the CR number, a two-line title,
  author and age, then a foot with its STATUS in words and its change count.
  Hovering one dims every other path and card (`.cf-flow.is-dim`).
- **Colour means branch or status, nothing else.** A lane's colour IS its
  identity (`--cf-main`, `--cf-lane-1..4`). A change type never gets a colour,
  so a red thing on screen always means the same thing.

**A state is never said in one channel alone** - it is a colour AND a line
style AND a mark, so the picture survives being small, printed, or read by
somebody who cannot separate the hues (`STATUS`, `STATUS_COLOR`):

| state | colour | line | ends in |
|---|---|---|---|
| draft | `--cf-draft` slate | fine dash | a small ring - it is going nowhere yet |
| pending review | `--cf-review` amber | dotted | a dashed ring ON the target lane |
| approved | `--cf-merged` green | long dash | a dashed ring ON the target lane |
| published | the lane's own colour | solid | the real merge commit |
| rejected | `--cf-reject` red | broken dash | a crossed node |

Only four status hues, and a fifth would start colliding with the lanes:
approved deliberately shares published's green because it has the same destiny,
and its long dash is what says it has not got there yet. A card wears its
status as a full-strength rail across the top plus the faintest wash of the
same colour, never as a solid block - the title stays the loudest thing on it.

**A change waiting on a person is the loudest thing in the picture**, because
"what is waiting on me, and where is it going" is the question this screen
exists to answer. Its path does not stop at its card: it runs on, dotted, to
the exact point on the branch it is asking to land (`PROJECT_RUN`), and puts a
dashed ring there. On the trunk that point is always past HEAD (`HEAD_CLEAR`) -
a merge happens after the commit it merges onto, and it keeps the ring out from
under the HEAD pill. Several waiting on one lane queue behind each other
(`PROJECT_STAGGER`) rather than stacking on one spot.

**The viewer's own unfinished work is picked out** (`Flow.active`, matched
through `useIdentity`): a halo that slowly breathes, a thicker path, and "Your
draft" instead of "Draft". A draft's colour is the quietest on the screen by
design, so motion - not a borrowed hue - is what makes it findable. It is off
under `prefers-reduced-motion`.

Node SHAPE, not colour, says what a dot is: filled circle = commit, ring +
core = merge, glowing star = HEAD, dashed ring = a merge that has not happened
yet, crossed circle = rejected. Hovering a dot names its commit in full and
clicking copies it. Two changes forking from one commit leave the same dot;
cards fan above and below their lane so several simultaneous changes never
stack on top of each other.

The horizontal scale is ORDINAL, and has THREE rules that are easy to break and
obvious when broken. A stop is per COMMIT, not per instant - a pipeline that
lands three changes in the same second is still three commits, and keying x off
distinct timestamps drew them all on top of one another. Every stop is ONE
`STEP` wide: x counts commits, never minutes, because a scale that paid pixels
for elapsed time made a quiet weekend a quarter-screen of nothing and a month of
history mostly blank. So there is no axis along the bottom - each dot writes its
own timestamp underneath itself (`NodeStamp`, the date line dropped when the
whole history is inside one day), which is exact rather than estimated off a
ruler. And a change's own gaps are WIDENED (`LEAD` + `CROSS_LEAD` per lane
crossed) until its card plus a run either side actually fits, so the commits at
both ends really do move apart and the curve never falls vertically out of its
branch. Everything else - every node, every card, every stamp - reads its x from
that one scale, so the picture stays internally honest.

Two levels, and the difference is load-bearing. WORKSPACE-level views (Home,
Applications, Inbox, Audit, Instances estate, Settings) need no application and
have their own paths (`/home`, `/applications`, `/inbox`, `/audit`, …).
APPLICATION-level views are tabs of `ConfigurationPage` under
`/application/<id>/<tab>`. A view reads its data accordingly:

- `useRepoQuery` (`repoQuery.ts`) for ANYTHING repo-scoped - it gates the read
  on an active application, so an empty workspace never polls (or errors) for
  data that cannot exist. Plain `useQuery` is only for workspace-level reads.
- `deployment.ts` (`useHealth`/`useDeployment`) for the service's own identity;
  `/api/meta` carries the same fields but is repo-scoped, so it is unusable
  with no application connected.
- `BootGate` (`main.tsx`) probes the service before ANY view renders: a branded
  splash while checking, an on-brand service-unavailable page (auto-retrying)
  when it cannot be reached, the app once it answers.
- `useCapabilities` (`deployment.ts`, backed by `GET /api/capabilities`) for
  anything a deployment may not support. Offer only what will work here: local
  folder browsing reads the SERVER's filesystem, so it exists on a developer's
  own machine and nowhere else. Never render a control the deployment cannot
  honor, and never explain the gap in terms of environment variables - the UI
  says the integration is unavailable and points at an administrator; the
  startup log says which variable is missing.

## Conventions

- **Glossary (use everywhere):** Application, Instance, Parameter, Binding,
  Draft/Changes, Published. Cell provenance: default / base / instance.
- Nothing writes values outside pathedit/writeback; nothing writes
  `.configer` outside `writer`.
- API writes take an `author` body field but the session identity always
  wins (`api.author(r, fallback)`).
- Errors to users are plain words, never git jargon; every write path
  validates first and returns 422 with the parameter named.
- A missing precondition is a STATE, not an error: no application connected
  (`no_repository`), nothing recorded yet, no instances found. Show the empty
  state that says what to do next; never a red toast.
- One sentence gets `InlineNotice` (one line, control height), not an `Alert`
  block. Reserve `Alert` for the rare message that truly needs a paragraph.
- Every screen works down to 375px: dialogs cap to the viewport, card rows
  wrap, and the phone tier keeps the same brand mark, profile entry and
  navigation levels as the desktop rail.
- Tests: golden-style (exact expected file bytes) for anything that edits
  files; fixtures under `backend/internal/layout/testdata/` cover all three
  layouts; `api/platform_test.go` is the role-enforcement matrix.
- Keep Go files ≤ ~400 lines and single-purpose; split by resource, not by
  layer.
- **Never use an em-dash (the U+2014 character) anywhere**: not in code,
  comments, UI strings, commit messages, or docs. Use a spaced hyphen
  (` - `), a colon, or two sentences instead. This is enforced: `make lint`
  fails if any U+2014 is found in a tracked source file.

## The `.configer` schema (quick reference)

```yaml
# parameters.yaml
parameters:
  - id: net-admin-port          # slug, unique
    name: network.admin.port    # dotted logical name
    category: Networking/IP     # "/" nests the tree
    type: integer               # string|integer|number|boolean|enum|ipv4|ipv6|cidr|
                                #   hostname|port|email|url|mac|cpu|memory|duration|
                                #   percentage|list
    # cpu/memory validate positivity AND units. memory always needs one (a bare
    # number is bytes). CPU accepts both legal Kubernetes spellings (350m, 2), so
    # the unit rule is applied to the EDIT instead: a value written in millicores
    # may not lose the "m" (validate.UnitChange, called by the write paths once
    # the committed value is known - same shape as the AtLeast/AtMost relations).
    # validation may also carry atLeast/atMost: <paramId> for cross-field rules
    # (a resource limit must be at least its request, and vice versa).
    scope: instance             # instance | global (lives in a shared file)
    bindings:
      - { file: "{folder}/values.yaml", path: $.network.admin.port, format: yaml }
    validation: { preset: port, required: true }   # + pattern/min/max/enum/schemaRef
    versionIntroduced: v24.3.1  # drives new/deprecated/na cell states
    source: { sourceId: platform-defaults, key: $.network.admin.port }  # optional: pull from an external source

# sources.yaml (external parameter sources; connection metadata only, no creds)
sources:
  - id: platform-defaults
    name: Platform defaults repo
    kind: git                   # source plugin id (git | vault | ...)
    config: { repoUrl: "https://github.com/acme/defaults", branch: main, path: net.yaml }
  - id: prod-vault
    name: Prod Vault
    kind: vault
    secret: true                # values masked; written back as a reference
    config: { address: "https://vault.internal", mount: secret, path: telco/prod }

# instances.yaml
instances:
  - { name: prod-us-east, folder: instances/prod-us-east,
      environment: production, region: us-east, softwareVersion: v24.3.1 }
```
