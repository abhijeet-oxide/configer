#!/usr/bin/env node
// The runtime probe: what static analysis cannot see.
//
// A headless browser walks the application's main screens and records the
// things that only exist while the code is running:
//
//   * console errors and uncaught exceptions        (budget: zero)
//   * requests issued per screen                    (budget: no big growth)
//   * the SAME request issued more than once        (a duplicate fetch)
//   * polling: the same URL on a repeating interval
//   * responses that are slow, or oversized
//   * accessibility violations, via axe-core if it is installed
//   * screens that never leave their loading state
//
// This is one of the few places the platform builds rather than buys, and the
// justification is narrow: Playwright does the driving, axe-core does the
// accessibility analysis, and the custom part is the bookkeeping that answers
// "did this screen fetch the same thing twice", which no off-the-shelf tool
// asks. Everything it emits is the cq native format, so the orchestrator needs
// no knowledge of it whatsoever.
//
//   usage:  node runtime-probe.mjs <out.json>
//   env:    CQ_PROBE_BASE_URL   where the app is served (default :5173)
//           CQ_PROBE_ROUTES     comma-separated routes to visit

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const outPath = process.argv[2] ?? ".cq/artifacts/runtime-probe.json";
const baseURL = process.env.CQ_PROBE_BASE_URL ?? "http://127.0.0.1:5173";
const routes = (process.env.CQ_PROBE_ROUTES ?? "/,/applications,/inbox,/audit")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

const SLOW_MS = Number(process.env.CQ_PROBE_SLOW_MS ?? 800);
const BIG_BYTES = Number(process.env.CQ_PROBE_BIG_BYTES ?? 512 * 1024);
const SETTLE_MS = Number(process.env.CQ_PROBE_SETTLE_MS ?? 2500);

const findings = [];
const metrics = [];
const add = (id, name, value, direction = "lower_is_better", unit = "count", subject = "") =>
  metrics.push({ id, name, value: Number(value) || 0, unit, direction, subject, category: "frontend" });

function bail(reason) {
  // A probe that cannot run reports NOTHING rather than reporting zero. A
  // measurement of zero console errors from a browser that never started is
  // the most dangerous number this file could produce.
  process.stderr.write(`runtime-probe: ${reason}\n`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ findings: [], metrics: [] }, null, 2) + "\n");
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  bail("Playwright is not installed here, so the runtime probe was skipped.");
}

// axe-core is optional. When it is absent the probe still does everything else
// and simply does not claim an accessibility result.
let injectAxe = null;
try {
  const axe = await import("axe-core");
  injectAxe = axe.source ?? axe.default?.source ?? null;
} catch {
  /* accessibility is not measured on this runner */
}

let browser;
try {
  browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
} catch (err) {
  bail(`a browser could not be started (${err.message}).`);
}

let totalConsoleErrors = 0;
let totalExceptions = 0;
let totalRequests = 0;
let totalDuplicates = 0;
let totalA11y = 0;
let reachable = 0;

for (const route of routes) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  const requests = new Map(); // "METHOD url" -> [{start, ms, bytes}]
  const consoleErrors = [];
  const exceptions = [];

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // A failed network request also surfaces as a console error; counting it
    // twice would make one problem look like two.
    if (/Failed to load resource/i.test(text)) return;
    consoleErrors.push(text);
  });
  page.on("pageerror", (err) => exceptions.push(err.message));
  page.on("request", (req) => {
    const key = `${req.method()} ${stripCacheBusters(req.url())}`;
    const list = requests.get(key) ?? [];
    list.push({ start: Date.now() });
    requests.set(key, list);
  });
  page.on("response", async (res) => {
    const key = `${res.request().method()} ${stripCacheBusters(res.url())}`;
    const list = requests.get(key);
    if (!list?.length) return;
    const rec = list[list.length - 1];
    rec.ms = Date.now() - rec.start;
    rec.status = res.status();
    try {
      const len = res.headers()["content-length"];
      rec.bytes = len ? Number(len) : (await res.body().catch(() => Buffer.alloc(0))).length;
    } catch {
      rec.bytes = 0;
    }
  });

  let loaded = true;
  try {
    await page.goto(route, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // Settle rather than networkidle: an application with a poll or a websocket
    // never goes idle, and waiting for it to would time out on exactly the
    // applications this probe is most useful on.
    await page.waitForTimeout(SETTLE_MS);
    reachable++;
  } catch (err) {
    loaded = false;
    findings.push({
      rule: "runtime/unreachable",
      title: `${route} did not load`,
      detail: err.message,
      severity: "error",
      confidence: "high",
      file: "frontend/src/App.tsx",
      component: route,
      recommendation:
        "The route did not reach DOMContentLoaded. Check that the dev server is serving this path and that the router knows it.",
      tags: ["broken-navigation"],
    });
  }

  if (loaded) {
    // --- console errors and exceptions ------------------------------------
    for (const text of dedupeTexts(consoleErrors)) {
      totalConsoleErrors++;
      findings.push({
        rule: "runtime/console-error",
        title: `Console error on ${route}: ${clip(text, 120)}`,
        severity: "error",
        confidence: "high",
        file: "frontend/src",
        component: route,
        evidence: clip(text, 200),
        recommendation:
          "A console error on a main screen is a defect the user will hit. Trace it from the stack in the artifact and fix the cause, not the message.",
        tags: ["console-error"],
      });
    }
    for (const text of dedupeTexts(exceptions)) {
      totalExceptions++;
      findings.push({
        rule: "runtime/uncaught-exception",
        title: `Uncaught exception on ${route}: ${clip(text, 120)}`,
        severity: "blocker",
        confidence: "high",
        file: "frontend/src",
        component: route,
        evidence: clip(text, 200),
        recommendation:
          "An uncaught exception during render leaves the screen in an undefined state. Guard the value it dereferenced, or give the boundary something to render.",
        tags: ["console-error"],
      });
    }

    // --- network ----------------------------------------------------------
    let routeRequests = 0;
    for (const [key, list] of requests) {
      routeRequests += list.length;
      if (list.length > 1 && isApp(key)) {
        totalDuplicates++;
        const gaps = list.slice(1).map((r, i) => r.start - list[i].start);
        const periodic = gaps.length >= 2 && spread(gaps) < 250;
        findings.push({
          rule: periodic ? "runtime/polling" : "runtime/duplicate-request",
          title: periodic
            ? `${route} polls ${key} every ~${Math.round(mean(gaps))}ms`
            : `${route} requests ${key} ${list.length} times`,
          severity: periodic ? "warning" : "warning",
          confidence: periodic ? "medium" : "high",
          file: "frontend/src/api.ts",
          component: route,
          recommendation: periodic
            ? "If this is a deliberate poll, say so in the query's refetchInterval and make sure it stops when the tab is hidden. If it is not, something is invalidating the query on every render."
            : "Two components asked for the same thing independently. Share one query key so react-query serves both from one request.",
          tags: ["api-regression", "duplicate-request"],
        });
      }
      for (const rec of list) {
        if (rec.ms > SLOW_MS && isApp(key)) {
          findings.push({
            rule: "runtime/slow-response",
            title: `${key} took ${rec.ms}ms on ${route}`,
            severity: "warning",
            confidence: "high",
            file: "backend/internal/api",
            component: key,
            recommendation:
              "A request this slow on first paint blocks the screen. Profile the handler, or move the call off the critical path.",
            tags: ["api-regression", "backend-performance"],
          });
        }
        if ((rec.bytes ?? 0) > BIG_BYTES && isApp(key)) {
          findings.push({
            rule: "runtime/oversized-payload",
            title: `${key} returned ${(rec.bytes / 1024).toFixed(0)} KiB on ${route}`,
            severity: "warning",
            confidence: "high",
            file: "backend/internal/api",
            component: key,
            recommendation:
              "Page or project the response. A payload this size is mostly fields the screen never reads.",
            tags: ["api-regression"],
          });
        }
      }
    }
    totalRequests += routeRequests;
    add("frontend.network.requests", "Network requests on load", routeRequests, "lower_is_better", "count", route);

    // --- stuck loading states ---------------------------------------------
    const stillLoading = await page
      .locator('[aria-busy="true"], .ant-spin-spinning, [data-loading="true"]')
      .count()
      .catch(() => 0);
    if (stillLoading > 0) {
      findings.push({
        rule: "runtime/stuck-loading",
        title: `${route} is still showing a loading state after ${SETTLE_MS}ms`,
        severity: "warning",
        confidence: "medium",
        file: "frontend/src",
        component: route,
        recommendation:
          "Either the query never resolves, or the loading flag is never cleared on the error path. Check what the screen does when the request fails.",
        tags: ["loading-state"],
      });
    }

    // --- accessibility, via axe-core --------------------------------------
    if (injectAxe) {
      try {
        await page.addScriptTag({ content: injectAxe });
        const results = await page.evaluate(async () =>
          // eslint-disable-next-line no-undef
          await window.axe.run(document, { resultTypes: ["violations"] }),
        );
        for (const v of results.violations ?? []) {
          totalA11y++;
          findings.push({
            rule: "axe/" + v.id,
            title: `${route}: ${v.help}`,
            detail: v.description,
            severity: v.impact === "critical" || v.impact === "serious" ? "error" : "warning",
            confidence: "high",
            file: "frontend/src",
            component: route,
            evidence: clip(v.nodes?.[0]?.html ?? "", 200),
            docsUrl: v.helpUrl,
            recommendation: v.help,
            tags: ["accessibility"],
          });
        }
        add("frontend.a11y.violations", "Accessibility violations", results.violations?.length ?? 0,
          "lower_is_better", "count", route);
      } catch (err) {
        process.stderr.write(`runtime-probe: axe did not run on ${route}: ${err.message}\n`);
      }
    }
  }

  await context.close();
}

await browser.close();

add("frontend.console.errors", "Console errors", totalConsoleErrors);
add("frontend.console.exceptions", "Uncaught exceptions", totalExceptions);
add("frontend.network.requests", "Network requests across the probed screens", totalRequests);
add("frontend.network.duplicates", "Duplicated or polled requests", totalDuplicates);
add("frontend.a11y.violations", "Accessibility violations", totalA11y);
add("frontend.routes.reachable", "Routes that loaded", reachable, "higher_is_better");

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ findings, metrics }, null, 2) + "\n");
process.stdout.write(
  `runtime-probe: ${routes.length} route(s), ${totalConsoleErrors} console error(s), ` +
    `${totalDuplicates} duplicate request(s), ${totalA11y} accessibility violation(s)\n`,
);

// --- helpers ---------------------------------------------------------------

// stripCacheBusters removes the query parameters that change on every call, so
// two requests for the same resource are recognized as the same request.
function stripCacheBusters(url) {
  try {
    const u = new URL(url);
    for (const k of ["_", "t", "ts", "cacheBust", "v"]) u.searchParams.delete(k);
    return u.origin + u.pathname + (u.search || "");
  } catch {
    return url;
  }
}

// isApp filters out the requests the application did not choose to make: the
// dev server's own module graph, fonts, source maps.
function isApp(key) {
  return !/\.(map|woff2?|ttf|png|jpe?g|svg|ico)(\?|$)/i.test(key) && !/\/@(vite|react|fs)\//.test(key);
}

function dedupeTexts(list) {
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const k = t.replace(/\d+/g, "#").slice(0, 160);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const spread = (xs) => Math.max(...xs) - Math.min(...xs);
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "..." : s);
