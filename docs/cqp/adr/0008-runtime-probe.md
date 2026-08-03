# ADR-0008: Build the runtime probe, buy everything else

**Status:** Accepted

## Context

The required detections include several that no static analyzer can answer, and
that no single off-the-shelf tool answers either:

- console errors and uncaught exceptions on the real screens
- **duplicate API calls** - the same request issued twice on one render
- polling nobody meant to introduce
- oversized or slow responses as the browser actually experiences them
- screens stuck in a loading state
- accessibility violations on the rendered DOM

Lighthouse answers performance and a subset of accessibility on a page load.
Playwright drives a browser. axe-core analyzes a DOM. None of them keeps a
request ledger and asks "was this fetched twice".

## Decision

Build `scripts/cq/runtime-probe.mjs`: a Playwright script that walks the
application's main routes and records what only exists at runtime. It emits the
platform's native JSON format, so the orchestrator knows nothing about it.

The custom part is deliberately narrow. **Playwright does the driving, axe-core
does the accessibility analysis, and the ~40 lines that are genuinely ours are
the request bookkeeping**: normalizing away cache-busting parameters, grouping by
method and path, and deciding whether repeated requests are duplicates (two
components asking independently) or a poll (evenly spaced).

Three details that make it trustworthy rather than merely present:

- **A probe that cannot run reports nothing, not zero.** "Zero console errors"
  from a browser that never started is the most dangerous number this file could
  produce, so a missing Playwright or a failed launch writes an empty result and
  the analyzer is reported as skipped.
- **It settles rather than waiting for network idle.** An application with a poll
  or a websocket never goes idle, and waiting for it would time out on exactly
  the applications this probe is most useful on.
- **axe-core is optional.** Without it the probe still does everything else and
  simply does not claim an accessibility result.

## Alternatives considered

**Lighthouse alone.** Covers performance and page-level accessibility, and has
nothing to say about duplicate requests or a stuck spinner. It is still in the
catalog, at the `main` tier, for what it is good at.
**A browser extension or devtools protocol scraper.** More data, far more code,
and no CI story.
**Instrument the application itself** (a fetch wrapper counting duplicates).
Rejected: it is production code carrying test concerns, and it measures what the
instrumentation sees rather than what the browser does.
**why-did-you-render / React Scan for re-renders.** Both are development-time
overlays that need the app instrumented; neither has a CI output. Re-render risk
is instead caught statically by the React Compiler and `react-hooks` ESLint
rules, which the ESLint normalizer re-labels into the frontend-performance
category. That is a genuine gap: the static rules find *risk*, not *occurrence*.
The roadmap tracks it.

## Consequences

- ~250 lines of JavaScript that this project now maintains.
- It needs a served application, which is why it is `pr`-tier and optional.
- Its thresholds (800ms slow, 512 KiB oversized, 2.5s settle) are environment
  variables, because a CI runner and a laptop are not the same machine.

## What would change our minds

A maintained open source tool that emits duplicate-request and polling findings
from a headless run in a machine-readable format. If one appears, this script
becomes a manifest pointing at it and the native format stays exactly as it is.
