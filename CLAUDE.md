# Configer - contributor guide

Configer is a **write-back-native** GitOps configuration UI: it renders an
existing repository's config as a parameter×instance grid and edits the
repository's OWN files surgically. `.configer/` holds metadata only - never
values, never generated artifacts. Every UI action is an ordinary Git
operation (draft → branch → commit → PR → merge).

## Commands

```bash
make install        # go modules + npm (first time)
make dev            # backend :8080 (serves ./sample-repo) + frontend :5173
make test           # go test ./... + tsc --noEmit
make lint           # go vet + golangci-lint + eslint
make build          # backend binary + frontend dist
./scripts/smoke.sh  # end-to-end: onboard fixture, edit, submit, assert branch diff
```

Backend alone: `cd backend && CONFIGER_REPO=../sample-repo go run ./cmd/configer`.
Verification bar for any change: `go vet`, `golangci-lint run`, `go test ./...`,
`npx tsc --noEmit`, `npx eslint src`, and the smoke script all green.

## Architecture (backend, `backend/internal/`)

**The edit spine - every write goes through here:**
- `pathedit` - THE single engine for reading/surgically editing YAML/JSON/XML
  documents. Comment-preserving yaml.Node edits; order-preserving JSON
  emission; XML via etree. Paths: dotted (`$.a.b`, `servers[2]`,
  `rules[name=ssh].port`) or XPath for XML. Never add a second path engine.
- `writeback` - file-level wrapper: read file, pathedit, write file.
- `change` / `changeset` / `crstore` - the change-request lifecycle
  (Draft→UnderReview→Approved→Published). `changeset.Submit` opens an
  isolated worktree on `configer/cr-<n>`, applies draft items (structural
  instance changes → direct file edits → value edits), commits with a
  `Changed-by:` trailer, pushes, opens a GitHub PR. CR workflow state lives
  in a JSON file beside the repo (rebuildable; not the platform DB).

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
GitHub Git-data-API no-clone), `remoterepo`, `provider` (GitHub PRs),
`api/sync` (poll fetch+ff), `api/reconcile` (external-commit findings).

**Platform (optional, off without OAuth env):** `store` (SQLite default /
Postgres via DATABASE_URL: users, sessions, app_members, audit_events),
`auth` (GitHub OAuth, cookie sessions), `api/platform.go` (role enforcement:
viewer < editor < approver, merge is approver-gated; members endpoints
admin-only; audit trail). Configuration data NEVER goes in the DB.

**HTTP:** `api/hub.go` (workspace: /api/repos/{id}/… + auth + dispatch),
per-repo handlers split by resource (`reads.go`, `values.go`,
`parameters.go`, `instances.go`, `changes.go`, `files.go`, `onboarding.go`,
`reconcile.go`, `helpers.go`).

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
`ComparePanel`, `WorkspaceView`.

## Conventions

- **Glossary (use everywhere):** Application, Instance, Parameter, Binding,
  Draft/Changes, Published. Cell provenance: default / base / instance.
- Nothing writes values outside pathedit/writeback; nothing writes
  `.configer` outside `writer`.
- API writes take an `author` body field but the session identity always
  wins (`api.author(r, fallback)`).
- Errors to users are plain words, never git jargon; every write path
  validates first and returns 422 with the parameter named.
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
    type: integer               # string|integer|number|boolean|enum|ipv4|cidr|list
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
