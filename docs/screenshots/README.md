# UI media

The current interface, captured from the live app. This folder is the living
visual record of the product: **regenerate it whenever the UI changes** so the
README and [FEATURES.md](../../FEATURES.md) always reflect reality.

## Regenerating

```bash
# 1. backend, pointed at the bundled demo repo
cd backend && CONFIGER_REPO=../sample-repo go run ./cmd/configer

# 2. frontend dev server
cd frontend && npm run dev

# 3. capture the gallery + the README demo GIF (writes here and ../demo.gif)
node scripts/capture-media.mjs
```

The script skips the first-run welcome tour, captures each page in light mode
plus the grid in dark mode, and records a short demo (grid -> resource
quantities -> inline validation -> staged edit -> compare) as `../demo.gif`. The
demo only STAGES a draft edit, so the sample repo's files are left untouched.

The demo GIF is encoded in pure JavaScript (`gifenc` + `pngjs`), so no system
video tooling is required.

## The gallery

| File | What it shows |
|------|---------------|
| `01-portfolio.png` | The applications portfolio: cards and the needs-attention rail. |
| `02-overview.png` | One application's Overview tab: health, changes, drift, targets. |
| `03-grid.png` | The parameter x instance grid: the heart of the product. |
| `04-compare.png` | Compare tab: parameter-level diff between two instances. |
| `05-files.png` | File mode: a Monaco editor over the instance's real files. |
| `06-instances.png` | Instances tab: the deployment targets. |
| `07-repository-changes.png` | Repository changes: drift detected from direct Git commits. |
| `08-validation.png` | Inline validation catching an invalid IPv4 before it saves. |
| `10-grid-dark.png` | The grid in dark mode. |
