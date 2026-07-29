# Managing a GitHub repository without cloning it

Configer can manage a GitHub repository entirely through GitHub's Git data API,
with no clone anywhere on the server. The code exists, works and has tests. It
is **not finished**, and it is **not reachable from the UI**. This note records
what is built, what is missing, and whether to finish it.

## What it is

Two ways to serve one application, chosen per repository:

| | Clone (today's default) | Remote (this) |
|---|---|---|
| On disk | a real git working tree | plain files, no `.git` |
| Reads | the working tree | a materialized cache, refreshed by the compare API |
| Writes | worktree, commit, push | a partial commit built from trees and blobs |
| Sync | `git fetch` + fast-forward | compare `base...head`, refetch only changed paths |
| Hosts | any git host | GitHub only |

Both sit behind `repobackend.Backend`, so every read path, the grid, the
resolver, validation and the change-request lifecycle are identical either way.
Only the git operations differ.

## How it is selected

There is **no configuration setting**. It is a per-repository choice made once,
when the repository is added, and stored on its registry row (`Entry.Remote`):

```bash
curl -X POST http://<configer>/api/repos \
  -d '{"url":"https://github.com/acme/config","mode":"remote"}'
```

`mode:"remote"` is the entire switch. The Add Application screen never sends it,
so through the product it cannot be reached. Once set it is permanent for that
application, and it survives restarts.

## Where the code is

| Piece | File | State |
|---|---|---|
| GitHub Git-data client | `backend/internal/remoterepo/remoterepo.go` | complete |
| Backend implementation | `backend/internal/repobackend/remote.go` | complete |
| Hub wiring | `backend/internal/api/hub.go` (`openRemote`) | complete |
| API entry point | `backend/internal/api/connect.go` (`mode`) | complete |
| Tests | `remoterepo_test.go`, `remote_test.go` | 3 tests, against a fake GitHub |
| UI | - | **missing** |

## What works

- Partial checkout: read the tree at a commit, fetch each blob, write plain files
- Partial commit: create blobs, build a tree, create a commit, move the ref
- Branch creation, deletion, merge
- Compare-driven refresh: only changed paths are refetched on sync
- Pull requests, through the same `provider` used by the clone path
- The whole change-request lifecycle: draft, submit, review, approve, publish

## What is left

Roughly in the order it would have to be done.

1. **`Log` returns nothing** (`remote.go`). History, the timeline, parameter
   history and cell history all render empty for a remote application. Needs the
   GitHub commits API.
2. **`ListRefs` returns only the default branch** (`remote.go`). The branch and
   tag picker collapses, so compare-against-a-branch has nothing to compare
   with. Needs the refs API.
3. **Materialization is one HTTP request per file, serially**
   (`remoterepo.go`, `Materialize`). A 2,000 file repository is 2,000 sequential
   round trips; adding it takes minutes. Needs concurrency, and ideally fetching
   only the files the catalog binds rather than the whole tree.
4. **Rate limits are unbudgeted.** Every blob is a REST call against 5,000 per
   hour, shared by the whole deployment. Needs conditional requests (a `304`
   does not count against the limit), a blob cache keyed by sha (blobs are
   immutable, so such a cache is never stale), and a visible error when the
   budget is spent.
5. **Trees larger than the API's limit are refused outright.** `Tree` errors on
   a truncated response, so a big monorepo cannot be added at all.
6. **No UI.** A checkbox, plus the disabled/explained state for non-GitHub URLs.
7. **No integration test through the Hub.** The unit tests cover the client and
   the backend; nothing exercises connect-to-publish in remote mode.

## Benefits

- **No disk.** Nothing to mount, nothing to size, nothing to keep.
- **No git binary** in the image.
- **No working tree to corrupt.** No stale locks, no half-finished merges, no
  leftover worktrees from a killed process.
- **A commit is exact.** The partial commit contains only the paths that
  changed, built from their content, so nothing can sweep in an unrelated
  working-tree file.
- **Fast for a small repository.** A handful of files is a handful of calls.

## Drawbacks

- **GitHub only.** `remoterepo.New` rejects anything else outright. No GitLab,
  no Bitbucket, no self-hosted git.
- **Loses history.** See items 1 and 2 above. These are most of what Configer is
  for, so a remote application is a visibly reduced product until they are done.
- **Scales badly with repository size**, in both time and rate-limit budget
  (items 3, 4, 5).
- **Every read depends on the network.** A clone can serve the grid with GitHub
  unreachable; this cannot.
- **A second engine to maintain.** Every git-touching feature has to be built
  twice and can regress on one side only.

## Recommendation

Compare it with what the clone path now does. Since this note was first needed,
the clone path has changed underneath it:

- Clones are **partial** (`--filter=blob:none`): all commits, all trees, all
  branches, with file contents fetched on demand. The download is a fraction of
  a full clone and the git protocol is not subject to the REST rate limit.
- Applications **open on first use**, so no clone is on the startup path.
- The registry and change-request state are in the **platform database**, so a
  pod holds nothing that has to survive it.

The result is that a Configer pod is already disposable while keeping full git,
every host, and every history feature. The working copy is a cache: present, and
startup is instant; absent, and it is rebuilt on use.

That removes the original reason for remote mode. What it still uniquely offers
is *literally no disk and no git binary*, which is a real constraint for some
deployments but a narrow one, bought at the price of GitHub-only and no history.

**Two options, and a preference.**

- **Finish it** (items 1 to 7) if there is a concrete deployment that cannot
  have a writable volume or a git binary, and is GitHub-only. Budget the
  rate-limit work seriously; it is the part most likely to fail in production
  rather than in review.
- **Harvest it, and close the entry point.** `remoterepo`'s sha-addressed blob
  fetching and tree walking are exactly what a shared, content-addressed blob
  cache needs, which is the next real scaling step for the clone path too. Take
  those parts; remove `mode:"remote"` from the public API so nobody discovers a
  half-built mode by accident and reports the empty History view as a bug.

The second is preferred unless such a deployment actually exists.

## If it is exposed to users

Then it should be an explicit, honest choice at the moment a repository is
added, not a hidden mode:

- A checkbox on the Add Application screen: **"Manage without cloning
  (GitHub only)"**.
- Only enabled when the URL is recognised as GitHub; otherwise disabled, saying
  why in one line, per the project's rule that a control the deployment cannot
  honor is never rendered as if it could.
- Wording that states the trade in plain terms, before it is chosen, for example:
  *"Configer will read and write this repository through GitHub instead of
  copying it to the server. History and branch comparison are not available for
  repositories managed this way."*
- The application card should carry a visible marker afterwards (the
  `noClone` field is already in `RepoSummary` and the frontend type), because
  "why is History empty here but not there" is otherwise unanswerable from
  the UI.

Do not ship the checkbox before items 1 and 2. A user who ticks it and finds
History permanently blank has been given a worse product with no warning, and
the setting cannot be undone without re-adding the application.
