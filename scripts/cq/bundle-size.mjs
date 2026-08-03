#!/usr/bin/env node
// Measure what the browser actually pays for: the gzipped bytes of the built
// bundle, per entry asset and in total.
//
// This is deliberately not size-limit itself. size-limit is the better tool and
// the manifest documents it as the recommendation for a repository that wants
// per-entry budgets with a config file; but it needs a config, a plugin for the
// bundler and an install, and the platform must produce a bundle number on a
// repository that has none of those. So this emits size-limit's OWN output
// shape, which means swapping in the real tool later is a one-line manifest
// change and no normalizer change at all.
//
//   usage:  node bundle-size.mjs <dist-dir> <out.json>

import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, extname, dirname, relative } from "node:path";

const [distDir, outPath] = process.argv.slice(2);
if (!distDir || !outPath) {
  process.stderr.write("usage: bundle-size.mjs <dist-dir> <out.json>\n");
  process.exit(2);
}

// Only the assets the browser downloads on a page load count. Source maps and
// the HTML shell are not what a bundle budget is about, and counting them makes
// the number move for reasons nobody can act on.
const COUNTED = new Set([".js", ".mjs", ".cjs", ".css"]);

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const files = walk(distDir).filter((p) => COUNTED.has(extname(p)) && !p.endsWith(".map"));
if (files.length === 0) {
  process.stderr.write(
    `bundle-size: nothing to measure in ${distDir}. Was the build run?\n`,
  );
}

const entries = files
  .map((p) => {
    const raw = readFileSync(p);
    return {
      name: relative(distDir, p).split("\\").join("/"),
      size: gzipSync(raw, { level: 9 }).length,
      rawSize: statSync(p).size,
      passed: true,
    };
  })
  // Largest first: the top of this list is where a regression came from.
  .sort((a, b) => b.size - a.size);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(entries, null, 2) + "\n");

const total = entries.reduce((n, e) => n + e.size, 0);
process.stdout.write(
  `bundle-size: ${entries.length} asset(s), ${(total / 1024).toFixed(1)} KiB gzipped\n`,
);
