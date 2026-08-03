# ADR-0007: Regression budgets over fixed thresholds

**Status:** Accepted

## Context

The specification asks for both: fixed budgets (performance 90+, accessibility
100%, coverage 85%, zero console errors) and regression budgets (bundle growth
under 5%, API call growth). They conflict in practice, and which one blocks a
merge is the single most consequential policy decision in the platform.

A fixed threshold has exactly two states on a real codebase. On day one it is
unreachable, so it is switched off or ignored. By day one hundred it is either
met and meaningless, or gamed.

## Decision

Every budget supports both forms. The **blocking** ones ship as regression
budgets; the aspirational absolutes ship `blocking: false`.

```yaml
- name: bundle-growth          # blocking
  metric: frontend.bundle.total_gzip
  maxIncreasePct: 5
  warnAt: 2

- name: lighthouse-performance # advisory
  metric: frontend.lighthouse.performance|*
  min: 85
  warnAt: 90
  blocking: false
```

Four rules make this work:

1. **A regression budget with no baseline reports `skip`, never `pass`.**
   This is the decision that makes the gate trustworthy. Reporting `pass` would
   silently disable every regression budget on every new branch - which is
   exactly when people believe it most.
2. **An unmeasured metric reports `skip`.** A documentation change does not
   measure the bundle, and claiming it did not regress would be a lie.
3. **`onlyNew` exists on finding budgets.** `no-new-blocking-findings` holds the
   line at zero without demanding the existing backlog be cleared first. This is
   what makes a strict budget adoptable on a repository that already has debt.
4. **The baseline is the merge base, not the branch tip.** A pull request is
   answerable for what it changed, not for what landed on main while it was open.

Absolute zero is still used where zero is genuinely the only acceptable number:
critical security findings, committed secrets, console errors, data races,
goroutine leaks, breaking API changes.

## Alternatives considered

**Fixed thresholds only.** Simple, and it is what gets switched off first.
**Regression only.** Lets a codebase degrade one acceptable step at a time
forever. The advisory absolutes are the counterweight, and they are visible in
every report even when they do not block.
**Statistical process control on the metric history.** Better in principle,
particularly for noisy metrics. It needs a metric store and a lot of history; the
roadmap has it, and `benchstat` already does the statistics for the noisiest
metric here.

## Consequences

- The `main` branch must record a baseline, so the pipeline has a `--baseline`
  step and a cache to carry it. If that step breaks, gates degrade to `skip`
  rather than to false confidence.
- A budget can be introduced safely: ship it advisory, watch it for a fortnight,
  flip `blocking`.
- Every failure message names the measurement, the baseline, the delta, the rule
  and the ref it compared against, because a failure a reader has to decode is a
  failure they will route around. The policy tests assert the exact wording.

## What would change our minds

Nothing about the ordering. The specific default percentages (5% bundle, 10%
latency, 15% benchmark, 25% API calls) are guesses that should be tuned from
observed variance once there is history.
