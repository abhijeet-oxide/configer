# UI screenshot gallery

The current interface, one screenshot per page and per action. This folder is
the living visual record of the product: **regenerate it whenever the UI
changes** so reviews and docs always reflect reality.

## Regenerating

```bash
# 1. backend, pointed at the demo GitHub stub the script hosts on :8124
cd backend && CONFIGER_REPO=../sample-repo \
  GITHUB_API_URL=http://127.0.0.1:8124 CONFIGER_GITHUB_TOKEN=demo \
  go run ./cmd/configer

# 2. frontend dev server
cd frontend && npm run dev

# 3. capture (writes into this folder)
node scripts/screenshots.mjs
```

The script stages one draft edit through the API so the editor shows live
content (reverted afterwards — nothing is committed to the sample
repository). It also builds a disposable second application, `payments-demo`,
from a temp copy of sample-repo, submits a real change request and makes one
commit directly on Git — so the Approvals, Release history and Repository
changes screenshots show those pages doing their job. That application is
disconnected and deleted when the run finishes.

## The gallery

### Level 1 — the Applications portfolio

| # | Screenshot | What it shows |
|---|------------|---------------|
| 01 | ![](01-applications-overview.png) | The landing page: quick-glance application cards and the **Needs attention** rail. |
| 02 | ![](02-application-quick-view.png) | Clicking a card opens the **quick view side panel**: stats, environments, recent activity, and the door into the full configuration. |

### Creating an application

| # | Screenshot | What it shows |
|---|------------|---------------|
| 03 | ![](03-new-application-signin.png) | Signed out: the wizard asks to **Continue with GitHub** (manual URL entry stays available). |
| 04 | ![](04-new-application-pick-repository.png) | Signed in: pick from **your repositories and organizations**, searchable, no URLs or tokens. |
| 05 | ![](05-new-application-pick-branch.png) | Pick the **branch** that holds the configuration. |
| 06 | ![](06-new-application-name-and-create.png) | Name the application and **create & scan** — the repository is parsed immediately. |

### Level 2 — the Configuration page (everything about one application, as tabs)

| # | Screenshot | What it shows |
|---|------------|---------------|
| 07 | ![](07-configuration-overview.png) | **Overview** tab: health signals, stat cards, system health map, activity. |
| 08 | ![](08-configuration-editor.png) | **Editor** tab: the parameter×instance grid with groups tree and details panel. |
| 09 | ![](09-configuration-compare.png) | **Compare** tab: two instances/versions, parameter-level diff. |
| 10 | ![](10-configuration-release-history.png) | **Release history** tab: every change request and its state (a draft and one under review). |
| 11 | ![](11-configuration-approvals.png) | **Approvals** tab: the review pipeline stats, the queue, and the selected change request with before→after values and one-click decisions. |
| 12 | ![](12-configuration-instances.png) | **Instances** tab: the deployment targets. |
| 13 | ![](13-configuration-files.png) | **Files** tab: the repository's real files, editable with drafts. |
| 14 | ![](14-configuration-repository-changes.png) | **Repository changes** tab: per-type drift tiles (clickable filters) and a detected out-of-band commit with its one-click resolution. |
| 15 | ![](15-configuration-import.png) | **Import**: scan the repository and choose which settings to manage. |

### Loading & theming

| # | Screenshot | What it shows |
|---|------------|---------------|
| 16 | ![](16-loading-skeleton-editor.png) | Loading the editor: a **full-page skeleton** in the exact shape of the grid — the one loading language used everywhere. |
| 17 | ![](17-loading-skeleton-overview.png) | Loading the overview: same skeleton language, tab chrome stays interactive. |
| 18 | ![](18-dark-mode-overview.png) | Dark mode. |
