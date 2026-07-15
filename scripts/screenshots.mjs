#!/usr/bin/env node
// Captures the UI screenshot gallery under docs/screenshots/ so the docs
// always show the current interface. Re-run whenever the UI changes.
//
// Prerequisites (three terminals, or see docs/screenshots/README.md):
//   1. backend:  cd backend && CONFIGER_REPO=../sample-repo \
//        GITHUB_API_URL=http://127.0.0.1:8124 CONFIGER_GITHUB_TOKEN=demo \
//        go run ./cmd/configer
//   2. frontend: cd frontend && npm run dev
//   3. this:     node scripts/screenshots.mjs
//
// GITHUB_API_URL points the backend at the stub GitHub this script hosts on
// :8124, so the New Application wizard shows a stable, demo-safe repository
// list instead of a real account.

import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(
  new URL("../frontend/package.json", import.meta.url),
);
const { chromium } = require("playwright");

const BASE = process.env.SCREENSHOT_BASE_URL || "http://localhost:5173";
const API = process.env.SCREENSHOT_API_URL || "http://localhost:8080";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const APP = process.env.SCREENSHOT_APP_ID || "sample-repo";
// A second, disposable application built from a copy of sample-repo. It gets
// a real change request under review and a real out-of-band commit, so the
// Approvals / Release history / Repository changes screenshots show the
// pages doing their job instead of their empty states. Removed afterwards.
const DEMO_APP = "payments-demo";

// ---------------------------------------------------------------- gh stub

// A tiny fake GitHub API: enough for the New Application wizard (repository
// list + branches) to render realistic, stable content in screenshots.
const demoRepos = [
  ["acme/network-config", "Network device configuration for all regions", "main"],
  ["acme/payments-config", "Payment gateway settings, per environment", "main"],
  ["acme/edge-routing", "CDN and edge routing rules", "master"],
  ["telco-labs/core-params", "5G core parameters (kustomize)", "main"],
  ["telco-labs/site-profiles", "Per-site radio profiles", "main"],
];
function ghStub() {
  return createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/user/repos") {
      res.end(
        JSON.stringify(
          demoRepos.map(([full, description, branch], i) => ({
            full_name: full,
            name: full.split("/")[1],
            private: i % 2 === 0,
            description,
            default_branch: branch,
            pushed_at: new Date(Date.now() - i * 43e6).toISOString(),
            html_url: `https://github.com/${full}`,
            owner: { login: full.split("/")[0] },
          })),
        ),
      );
      return;
    }
    if (/^\/repos\/[^/]+\/[^/]+\/branches$/.test(url.pathname)) {
      res.end(
        JSON.stringify(
          ["main", "develop", "release/v24.3", "release/v24.2"].map((name) => ({ name })),
        ),
      );
      return;
    }
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) {
      res.end(JSON.stringify({ default_branch: "main" }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  }).listen(8124, "127.0.0.1");
}

// ------------------------------------------------------------------ setup

const api = async (method, p, body) => {
  const res = await fetch(`${API}/api${p}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${p}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
};

const git = (dir, cmd) => execSync(`git ${cmd}`, { cwd: dir, stdio: "pipe" });

// Build the disposable demo application: a fresh git repo copied from
// sample-repo, connected to the workspace, with (a) one change request
// submitted for review, (b) one fresh draft edit, and (c) one commit made
// directly on Git so drift findings exist. Everything lives in a temp dir
// and is disconnected + deleted at the end.
async function setupDemoApp() {
  const fix = path.join(os.tmpdir(), `configer-demo-${Date.now()}`);
  cpSync(path.join(ROOT, "sample-repo"), fix, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes(".git"),
  });
  git(fix, "init -b main");
  git(fix, 'config user.name "Priya"');
  git(fix, 'config user.email "priya@example.com"');
  git(fix, "add -A");
  git(fix, '-c commit.gpgsign=false commit -q -m "baseline configuration"');

  const repo = await api("POST", "/repos", { url: fix, name: DEMO_APP });
  const rp = (p) => `/repos/${encodeURIComponent(repo.id)}${p}`;

  // Pin the drift baseline to the current HEAD now, so the out-of-band
  // commit made below is detected as a finding (the baseline initializes
  // lazily on the first findings query).
  await api("GET", rp("/repo/findings"));

  // Three integer edits: two become the change request, one stays a draft.
  const grid = await api("GET", rp("/grid"));
  const edits = [];
  for (const row of grid.rows) {
    if (edits.length >= 3) break;
    if (row.param.type !== "integer") continue;
    for (const inst of grid.instances.slice(0, 2)) {
      const cell = row.cells[inst.name];
      if (!cell?.editable || typeof cell.value !== "number") continue;
      edits.push({ instance: inst.name, paramId: row.param.id, value: cell.value + 1 });
      if (edits.length >= 3) break;
    }
  }
  for (const e of edits.slice(0, 2)) await api("PUT", rp("/values"), { ...e, author: "priya" });
  const draft = await api("GET", rp("/changes/draft"));
  await api("POST", rp(`/changes/${draft.draft.id}/submit`), {
    title: "Raise admin ports for the v24.4 rollout",
    description: "Prepares the production fleet for next week's gateway update; staging already runs these values.",
    reference: "OPS-1043",
    category: "maintenance",
    author: "priya",
  });
  if (edits[2]) await api("PUT", rp("/values"), { ...edits[2], author: "priya" });

  // One commit straight on Git, outside Configer → a Repository changes finding.
  const folder = grid.instances[0]?.folder || "instances/prod";
  mkdirSync(path.join(fix, folder), { recursive: true });
  writeFileSync(
    path.join(fix, folder, "cache.yaml"),
    "cache:\n  ttlSeconds: 300\n  maxEntries: 10000\n  evictionPolicy: lru\n",
  );
  git(fix, "add -A");
  git(fix, '-c commit.gpgsign=false commit -q -m "cache tuning applied directly on the box"');

  return { id: repo.id, fix };
}

async function teardownDemoApp(demo) {
  if (!demo) return;
  await api("DELETE", `/repos/${encodeURIComponent(demo.id)}`).catch(() => {});
  rmSync(demo.fix, { recursive: true, force: true });
}

// Stage one draft edit so the editor, source control and release history
// show live content (reverted at the end — nothing is committed).
async function stageDemoEdit() {
  const grid = await api("GET", "/grid");
  for (const row of grid.rows) {
    if (row.param.type !== "integer") continue;
    for (const inst of grid.instances) {
      const cell = row.cells[inst.name];
      if (!cell?.editable || typeof cell.value !== "number") continue;
      await api("PUT", "/values", {
        instance: inst.name,
        paramId: row.param.id,
        value: cell.value + 1,
        author: "screenshot-bot",
      });
      return { paramId: row.param.id, instance: inst.name };
    }
  }
  return null;
}

async function main() {
  const stub = ghStub();
  mkdirSync(OUT, { recursive: true });
  // Prefer the environment-provided Chromium (PW_CHROMIUM / the managed
  // /opt/pw-browsers symlink) so no browser download is ever needed.
  const executablePath =
    process.env.PW_CHROMIUM ||
    (await import("node:fs").then((fs) =>
      fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined,
    ));
  const browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const shot = async (name) => {
    await page.waitForTimeout(450); // let charts/shimmers settle
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`  ✓ ${name}.png`);
  };
  const goto = async (view, app = APP) => {
    await page.goto(`${BASE}/?app=${app}&view=${view}`, { waitUntil: "networkidle" });
  };

  const edit = await stageDemoEdit().catch((e) => {
    console.warn(`  (no demo edit staged: ${e.message})`);
    return null;
  });
  const demo = await setupDemoApp().catch((e) => {
    console.warn(`  (no demo application: ${e.message})`);
    return null;
  });

  try {
    // -------- level 1: the Applications portfolio
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.getByText("Needs attention").waitFor();
    await shot("01-applications-overview");

    await page.locator(".ant-card", { hasText: "Quick view" }).first().click();
    await page.getByRole("button", { name: "Open configuration" }).waitFor();
    await shot("02-application-quick-view");
    await page.keyboard.press("Escape");

    // -------- the New Application wizard
    // Signed-out state first (status mocked), then the real stubbed flow.
    await page.route("**/api/github/status", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ available: false, source: "", signInEnabled: true }),
      }),
    );
    await page.getByRole("button", { name: "New application" }).first().click();
    await page.getByText("Connect your GitHub account").waitFor();
    await shot("03-new-application-signin");
    await page.keyboard.press("Escape");
    await page.unroute("**/api/github/status");

    await page.getByRole("button", { name: "New application" }).first().click();
    await page.getByText("acme/network-config").waitFor();
    await shot("04-new-application-pick-repository");

    await page.getByText("acme/network-config").click();
    await page.getByText("Create application & scan").waitFor();
    await page.waitForTimeout(600); // branches load into the select
    await shot("05-new-application-branch-name-create");
    await page.keyboard.press("Escape");

    // -------- level 2: the Configuration page, tab by tab
    // Review-flow tabs are captured on the demo application, which has a real
    // change request under review and real drift, so the pages show their job.
    const flowApp = demo ? DEMO_APP : APP;
    const tabs = [
      ["overview", "07-configuration-overview", APP],
      ["config", "08-configuration-editor", APP],
      ["compare", "09-configuration-compare", APP],
      ["changes", "10-configuration-release-history", flowApp],
      ["approvals", "11-configuration-approvals", flowApp],
      ["instances", "12-configuration-instances", APP],
      ["files", "13-configuration-files", APP],
      ["drift", "14-configuration-repository-changes", flowApp],
      ["import", "15-configuration-import", APP],
    ];
    for (const [view, name, app] of tabs) {
      await goto(view, app);
      if (view === "files") await page.waitForTimeout(2500); // Monaco loads lazily
      await shot(name);
    }

    // -------- the loading language: full-page skeletons
    // (the grid endpoint is repo-scoped: /api/repos/<id>/grid)
    const slowGrid = (url) => url.pathname.endsWith("/grid");
    await page.route(slowGrid, async (route) => {
      await new Promise((r) => setTimeout(r, 5000));
      await route.continue();
    });
    await page.goto(`${BASE}/?app=${APP}&view=config`);
    await page.locator(".sk").first().waitFor();
    await shot("16-loading-skeleton-editor");
    await page.goto(`${BASE}/?app=${APP}&view=overview`);
    await page.locator(".sk").first().waitFor();
    await shot("17-loading-skeleton-overview");
    await page.unroute(slowGrid);

    // -------- dark mode
    await goto("overview");
    await page.locator(".anticon-moon").first().click();
    await page.waitForTimeout(500);
    await shot("18-dark-mode-overview");
  } finally {
    if (edit) {
      await api(
        "DELETE",
        `/values?paramId=${encodeURIComponent(edit.paramId)}&instance=${encodeURIComponent(edit.instance)}`,
      ).catch(() => {});
    }
    await teardownDemoApp(demo);
    await browser.close();
    stub.close();
  }
  console.log(`\nGallery written to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
