---
name: verify-app
description: Verify a Configer change end-to-end - build, lint, unit tests, and the write-back smoke test against the bundled fixture. Use after any nontrivial backend or frontend change.
---

# Verify Configer

Run every gate; all must pass before a change is done.

## 1. Static + unit

```bash
cd backend && go vet ./... && go test ./...
cd ../frontend && npx tsc --noEmit && npx eslint src
```

(CI also runs `golangci-lint run` in `backend/` - run it locally when available.)

## 2. End-to-end write-back smoke

```bash
./scripts/smoke.sh
```

This boots the backend on a copy of `sample-repo/`, stages a cell edit, a
deduplicated edit (fans out to YAML + XML), a global (shared-file) edit, and
an invalid value (must 422), submits the draft, and asserts the
`configer/cr-1` branch carries exactly the expected surgical diffs - inline
comments preserved, no `generated/` artifacts, untouched instances unchanged.
`SMOKE OK` is the pass signal.

## 3. When the UI changed

```bash
cd frontend && npm run build     # full production build must succeed
make dev                         # then exercise the affected flow by hand:
```

- Grid: double-click a cell, commit a value, watch the pending badge and the
  Source Control panel.
- Files: open the Files view, confirm the Monaco diff shows the staged edit,
  save an edit and watch it appear as a pending cell.
- Onboarding: delete `.configer/` in a scratch copy of the fixture, connect
  it, and walk the wizard.

## Notes

- Anything that edits files needs a golden-style test (exact bytes), not a
  "contains" check.
- The fixture git-initializes itself on first run; `rm -rf sample-repo/.git`
  resets local experiments (never commit that directory).
