# Developer Guide

How to develop, test, and ship Configer. Architecture and code conventions
live in [`CLAUDE.md`](CLAUDE.md); configuration reference in
[`CONFIG.md`](CONFIG.md).

## Prerequisites

- Go 1.25+
- Node 22+ (npm)
- git (the backend shells out to it)
- Docker (only for the compose stack)

## Setup & daily workflow

```bash
make install     # go mod download + npm install
make dev         # backend :8080 (serving ./sample-repo) + frontend :5173
```

`make help` lists every target. The pieces individually:

```bash
# Backend against the bundled fixture
cd backend && CONFIGER_REPO=../sample-repo go run ./cmd/configer

# Frontend (Vite proxies /api -> :8080)
cd frontend && npm run dev
```

Copy `.env.example` to `.env` to override anything (`npm run setup` does it
for you). Interactive API docs: `http://localhost:8080/api/docs`.

## Testing & verification

```bash
make test           # go test ./... + tsc --noEmit
make lint           # go vet + eslint (CI also runs golangci-lint)
./scripts/smoke.sh  # end-to-end: boot on a fixture copy, stage edits via
                    # the API, submit, assert the CR branch's surgical diffs
```

Conventions worth knowing before writing tests:

- Anything that edits files gets a **golden-style test**: exact expected
  bytes, not just "contains" (see `internal/pathedit/pathedit_test.go`,
  `internal/changeset/changeset_test.go`).
- Layout/discovery fixtures for all three conventions live under
  `backend/internal/layout/testdata/{kpt,kustomize,plain}` and are shared by
  the discovery tests.
- `internal/api/platform_test.go` is the role-enforcement matrix (anonymous
  401, editor writes, merge approver-gated, admin-only member management)
  plus the single-user-mode regression.

## The sample fixture

`sample-repo/` is a plain-folders application: six instances under
`instances/<name>/` (YAML + an XML vendor file each), shared fleet config in
`shared/platform.yaml`, and a deliberately deduplicated `namespace` bound to
both files of every instance. The backend git-initializes it on first run;
delete `sample-repo/.git` to reset local experiments.

## Building & deployment

```bash
make build                          # backend binary + frontend dist/
cd deploy && docker compose up --build
```

The compose stack runs the backend (repo mounted read-write), the SPA behind
nginx (:8088), and Postgres as the platform database. Single-node
deployments can skip Postgres entirely - the platform store defaults to an
embedded SQLite file under `CONFIGER_DATA`.

To enable multi-user mode, create a GitHub OAuth app (callback
`<public-url>/api/auth/callback`) and set `GITHUB_OAUTH_CLIENT_ID/SECRET`
plus `CONFIGER_ADMINS`; see `CONFIG.md`.

## Troubleshooting

- **Backend won't start / "parameters.yaml not found"** - the repo isn't
  initialized; the UI routes to onboarding, or POST `/api/discover` +
  `/api/init` by hand.
- **Grid empty after external commits** - check `GET /api/repo/status`;
  sync is polling (`CONFIGER_SYNC_SECONDS`), `POST /api/repo/sync` forces it.
- **403 on merge** - publishing is approver-gated in multi-user mode;
  assign the role via People & roles (deployment admins only).
- **Where is CR state?** - workflow state is a JSON file under
  `.git/configer/` (or the data dir for no-clone repos); it is a rebuildable
  cache, never the source of truth.
