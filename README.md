# Configer

**A spreadsheet for your GitOps config - where your Git files stay the source of truth.**

Configer points at an existing repository, reads how it is already organized,
and shows your configuration as a grid: every **row is a parameter**, every
**column is an instance** (an environment, region, cluster, or site), every
**cell the value** for that instance. You edit cells; Configer edits your real
files and opens a normal pull request.

## The problem

A real fleet keeps its configuration in dozens of YAML/JSON/XML files spread
across environments, regions, and sites - Helm values, Kustomize overlays, kpt
packages, plain per-cluster folders. Two bad options follow:

- **Hand-edit the files.** The same setting lives in ten places, so a change
  means ten careful edits with nothing checking that a port is a port or that a
  memory limit is not below its request.
- **Build a config portal.** Now you have a second source of truth that drifts
  from Git, and a database nobody trusts.

Configer removes the choice. It gives you the portal *without* the second source
of truth: the grid is a **view over your Git files**, and every edit is an
ordinary commit.

## How it works

```
                        dev       staging    prod-us     prod-eu
  replicaCount          1         2          6           4
  image.tag             2.9.0     2.9.0      2.8.0       2.8.0
  service.port          8080      8080       8080        8080
  resources.limits.cpu  500m      500m       2           2       <- validated
  logging.level         debug     info       warn        warn    <- enum
```

- **Your files are the truth.** Nothing is generated or copied. Editing a cell
  makes a *surgical* edit to the real file - comments, key order, and blank
  lines preserved byte-for-byte - so the diff is exactly what a careful engineer
  would have written by hand.
- **The same setting is one row.** A `namespace` repeated across ten files
  becomes ONE row bound to ten locations; editing it fans out to all of them.
- **Every action is Git.** Edits collect into a draft; submitting cuts a branch
  and commit and opens a GitHub PR; approving merges. If Configer is down,
  nothing is blocked, and commits made directly in Git flow back into the grid.
- **Its own footprint is metadata only** - one `.configer/` folder describing
  where each parameter lives, its type, and its rules. Never any values.

## What you get

- **Onboarding in one click.** Point Configer at a repo and it detects the
  layout (Helm, Kustomize, kpt, or plain folders), derives the instances from
  the folders, extracts every tunable parameter, deduplicates settings repeated
  across files, and skips the structural noise (`kustomization.yaml`, Helm
  `templates/`, Kubernetes `apiVersion`/`kind`/`status`). Accepting the proposal
  is a single reviewable commit.
- **Validation that actually holds.** Types and rules are derived automatically -
  from JSON Schema files next to your config, from a preset library (ipv4, cidr,
  port, fqdn, url, semver, ...), and from the values themselves. Kubernetes
  quantities are first-class: `cpu` and `memory` validate their format *and*
  positivity, and a **resource limit is checked to be at least its request**.
  Every write is re-validated server-side and bad values are rejected.
- **A grid built for fleets.** Virtualized parameter x instance matrix with typed
  editors, per-cell provenance (own file / shared base / default, with the exact
  path), and version-aware cells (`new` / `deprecated` / `n/a`) driven by each
  instance's software version.
- **File mode.** A VS Code-style Monaco editor over the instance's real files,
  with a live committed-vs-draft diff. Grid edits and file edits are two views of
  the same draft.
- **Instances as reviewed changes.** Creating an instance scaffolds a new folder
  in your repo's own convention (a copied Kustomize overlay, a renamed kpt
  package, a plain folder) as part of a normal PR.
- **Compare.** Parameter-level diff between any two instances, at the working
  tree or across branches, tags, and commits: "staging today vs prod at v24.2"
  is one dropdown away.
- **Always live.** A background sync keeps the working tree current; external
  commits and new config files surface automatically for one-click import.
- **Team mode (optional).** Add a GitHub OAuth app and Configer becomes a shared
  deployment with sign-in, roles (viewer / editor / approver, publishing is
  approver-gated), and an audit trail. Without it, the single-user experience is
  untouched.

## Quick start

```bash
make install   # first time: go modules + npm
make dev       # backend :8080 + frontend :5173 (Ctrl-C stops both)
```

Open http://localhost:5173. The bundled `sample-repo/` (a telco fleet with six
instances, shared config, XML vendor files, a deduplicated namespace, and
validated CPU/memory limits) is served out of the box.

Want to see it read other shapes? `sample-repos/` holds realistic Helm,
Kustomize, kpt, raw multi-cluster Kubernetes, and telco-RAN repositories:

```bash
make backend CONFIGER_REPO=./sample-repos/helm-umbrella   # try any of them
make functional-test                                       # onboard + verify all of them
```

## Learn more

| Doc | What's in it |
|-----|--------------|
| [`CONFIG.md`](CONFIG.md) / [`.env.example`](.env.example) | Every configuration option. |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) / [`DEVELOPER_GUIDE.md`](DEVELOPER_GUIDE.md) | Local dev workflow. |
| [`CLAUDE.md`](CLAUDE.md) | Architecture, the `.configer` schema, and conventions. |
| `sample-repos/README.md` | The corpus of realistic repos the scanner is tested against. |
| `http://localhost:8080/api/docs` | Interactive API reference (spec generated from the code). |

The REST API mirrors the UI: `POST /api/discover` proposes an application,
`GET /api/grid` returns the matrix, `PUT /api/values` stages a validated edit,
`POST /api/changes/{id}/submit` opens the PR. Full spec at `/api/openapi.yaml`.

## Project layout

| Path | Description |
|------|-------------|
| `backend/` | Go API: layout detection, discovery/dedup, the `pathedit` engine (surgical YAML/JSON/XML edits), resolver, grid, change requests, git, and the optional platform. |
| `frontend/` | React + TypeScript + Ant Design SPA: grid, file mode, onboarding, instances, compare, approvals. |
| `sample-repo/` | The demo fixture served out of the box. |
| `sample-repos/` | Realistic Helm / Kustomize / kpt / K8s / telco repos for scanner testing. |
| `deploy/` | docker-compose stack (backend + frontend + Postgres). |
