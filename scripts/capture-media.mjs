#!/usr/bin/env node
// Capture the real UI: a screenshot gallery under docs/screenshots/ and an
// animated demo (docs/demo.gif) for the README. Re-run whenever the UI changes
// so the docs always show the current product.
//
// Prerequisites (two terminals):
//   1. backend:  cd backend && CONFIGER_REPO=../sample-repo go run ./cmd/configer
//   2. frontend: cd frontend && npm run dev
// then:          node scripts/capture-media.mjs
//
// The demo only STAGES a draft edit (never submits), so the sample repo's files
// are left untouched.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "frontend", "package.json"));
const { chromium } = require("playwright");
const { GIFEncoder, quantize, applyPalette } = require("gifenc");
const { PNG } = require("pngjs");

const BASE = process.env.CAPTURE_BASE_URL || "http://localhost:5173";
const APP = process.env.CAPTURE_APP_ID || "sample-repo";
const OUT = path.join(ROOT, "docs", "screenshots");
const GIF = path.join(ROOT, "docs", "demo.gif");
mkdirSync(OUT, { recursive: true });

// Resolve the Chromium the environment ships (Playwright's own download may be
// a different build); fall back to Playwright's default when absent.
function chromePath() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try {
    const dir = readdirSync(base).find((d) => d.startsWith("chromium-") && !d.includes("headless"));
    if (dir) {
      const exe = path.join(base, dir, "chrome-linux", "chrome");
      if (existsSync(exe)) return exe;
    }
  } catch {
    // fall through to the default
  }
  return undefined;
}

const routes = {
  home: `${BASE}/home`,
  overview: `${BASE}/application/${APP}`,
  grid: `${BASE}/application/${APP}/editor`,
  compare: `${BASE}/application/${APP}/compare`,
  files: `${BASE}/application/${APP}/files`,
  instances: `${BASE}/application/${APP}/instances`,
  repochanges: `${BASE}/application/${APP}/repository-changes`,
};

// initScript: skip the first-run welcome tour and pin the theme, before any app
// code runs, so captures are stable.
function initScript(theme) {
  return `
    try {
      localStorage.setItem("configer.welcomed.v1", "1");
      localStorage.setItem("configer.settings.v1", JSON.stringify({ theme: ${JSON.stringify(theme)} }));
    } catch (e) {}
  `;
}

async function settle(pg, ms = 1500) {
  await pg.waitForLoadState("networkidle").catch(() => {});
  await pg.waitForTimeout(ms);
}

async function go(pg, route, tabName) {
  await pg.goto(route, { waitUntil: "networkidle" }).catch(() => {});
  await settle(pg, 1200);
  // Some tabs redirect when navigated cold; click the tab as a fallback.
  if (tabName && !pg.url().includes(route.split("/").pop())) {
    await pg.getByRole("tab", { name: tabName }).click().catch(() => {});
    await settle(pg, 1200);
  }
}

async function shot(pg, name) {
  await pg.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log("  wrote", `docs/screenshots/${name}.png`);
}

async function gallery(browser, theme, suffix) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(initScript(theme));
  const pg = await ctx.newPage();

  if (!suffix) {
    await go(pg, routes.home);
    await shot(pg, "01-portfolio");
    await go(pg, routes.overview);
    await shot(pg, "02-overview");
  }

  await go(pg, routes.grid, "Parameters");
  await shot(pg, suffix ? `10-grid-${suffix}` : "03-grid");

  if (!suffix) {
    // Inline validation: an invalid IPv4 is caught in the cell before it saves.
    const gw = pg.locator(".ant-table-cell", { hasText: /^10\.10\.0\.20$/ }).first();
    if (await gw.count()) {
      await gw.dblclick().catch(() => {});
      await pg.waitForTimeout(400);
      await pg.keyboard.press("Control+A").catch(() => {});
      await pg.keyboard.type("999.1.1.1");
      await pg.waitForTimeout(900);
      await shot(pg, "08-validation");
      await pg.keyboard.press("Escape").catch(() => {});
      await pg.waitForTimeout(300);
    }
  }

  if (!suffix) {
    await go(pg, routes.compare, "Compare");
    await shot(pg, "04-compare");
    await go(pg, routes.files, "Files");
    await settle(pg, 1500);
    await shot(pg, "05-files");
    await go(pg, routes.instances, "Instances");
    await shot(pg, "06-instances");
    await go(pg, routes.repochanges, "Repository changes");
    await shot(pg, "07-repository-changes");
  }
  await ctx.close();
}

// ------------------------------------------------------------------ demo gif

async function captureFrames(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(initScript("light"));
  const pg = await ctx.newPage();
  const frames = [];
  const grab = async (holdMs) => {
    const buf = await pg.screenshot({ type: "png" });
    frames.push({ buf, delay: holdMs });
  };

  // 1. The grid: parameters x instances.
  await go(pg, routes.grid, "Parameters");
  await grab(1700);

  // 2. Filter to the Kubernetes resource rows (cpu/memory quantities), typed
  //    and validated automatically.
  const search = pg.getByPlaceholder(/search parameters/i);
  if (await search.count()) {
    await search.fill("resources").catch(() => {});
    await pg.waitForTimeout(1100);
    await grab(1900);
    await search.fill("").catch(() => {});
    await pg.waitForTimeout(800);
  }

  // 3. Edit an IPv4 cell with an invalid value: the inline validation fires.
  const gw = pg.locator(".ant-table-cell", { hasText: /^10\.10\.0\.20$/ }).first();
  if (await gw.count()) {
    await gw.dblclick().catch(() => {});
    await pg.waitForTimeout(450);
    await pg.keyboard.press("Control+A").catch(() => {});
    await pg.keyboard.type("999.1.1.1");
    await pg.waitForTimeout(900);
    await grab(2200); // the error frame

    // 4. Correct it to a valid address and commit: the edit stages into a draft.
    await pg.keyboard.press("Control+A").catch(() => {});
    await pg.keyboard.type("10.10.0.42");
    await pg.waitForTimeout(400);
    await pg.keyboard.press("Enter").catch(() => {});
    await pg.waitForTimeout(1300);
    await grab(2000);
  }

  // 5. Compare two instances: a parameter-level diff.
  await go(pg, routes.compare, "Compare");
  await grab(2400);

  await ctx.close();
  return frames;
}

function encodeGif(frames) {
  const enc = GIFEncoder();
  let w = 0;
  let h = 0;
  for (const { buf, delay } of frames) {
    const png = PNG.sync.read(buf);
    w = png.width;
    h = png.height;
    const rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
    const palette = quantize(rgba, 256);
    const index = applyPalette(rgba, palette);
    enc.writeFrame(index, w, h, { palette, delay });
  }
  enc.finish();
  return Buffer.from(enc.bytes());
}

async function main() {
  const executablePath = chromePath();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    console.log("Capturing light gallery...");
    await gallery(browser, "light");
    console.log("Capturing dark mode...");
    await gallery(browser, "dark", "dark");
    console.log("Recording demo frames...");
    const frames = await captureFrames(browser);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(GIF, encodeGif(frames));
    console.log(`Wrote docs/demo.gif (${frames.length} frames)`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
