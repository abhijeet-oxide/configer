# Configer - Product Vision

## The one-sentence intent

A user who has never thought about Git, YAML paths, Kustomize overlays, or
kpt packages should be able to open Configer, connect a repository, and
**edit configuration values for many deployment instances in a spreadsheet**
- with validation and review built in - while every edit is, underneath, a
real change to a real file, committed on a branch and merged via a pull
request that Configer manages on their behalf.

Two audiences, one tool:

- **The operator** never leaves the table. They pick an instance column,
  change a value, get instant validation, and hit "submit for review".
- **The engineer** can, at any moment, open file mode or Source Control and
  see exactly which files changed, on which branch, in a live Monaco diff.
  Nothing is hidden; it is just not *required*.

## The architecture that follows (shipped)

Configer is **write-back-native**. `.configer/` holds only metadata:
parameter definitions with validation and **bindings** (the real-file
locations each parameter lives at, templated per instance), and instance
definitions with their folder bindings. Values stay native in the
repository's own files; a cell edit writes back surgically at the mapped
locations; a deduplicated parameter (one setting in many files) fans out to
all of them; creating an instance scaffolds a folder following the repo's
own convention. There is no generated tree and no value database - Git is
the truth, and everything Configer does can also be done (and is detected
when done) directly on Git.

Layout adapters (kpt, Kustomize, plain per-instance folders) translate
between "the table" and "the files" both ways: detection at onboarding,
value resolution through the base→instance layer chain, and new-instance
scaffolding. The change-request pipeline (draft → branch → commit → PR →
publish) carries every kind of change: cell edits, direct file edits, and
instance topology.

The optional platform layer (GitHub OAuth, SQLite/Postgres, per-application
viewer/editor/approver roles, audit) makes one deployment serve a whole
team: an application initialized once is visible to everyone, and
publishing is approver-gated.

## Direction from here

- **Helm values adapter** - the one major layout not yet interpreted
  (values.yaml + per-env values files); the Adapter seam in
  `backend/internal/layout` is where it lands.
- **OAuth-driven repository picker** - onboarding currently takes a URL /
  local path; with login present, list the user's repositories and branches
  directly.
- **Parameter-level conflict resolution** - merge conflicts between change
  requests surfaced as value choices, never raw git text.
- **Webhook-driven sync** - replace the polling loop with push events where
  a GitHub App is installed.
- **Secrets** - encrypted-at-rest values (SOPS-style) surfaced as masked
  cells.
