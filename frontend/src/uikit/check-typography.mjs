#!/usr/bin/env node
// Raw pixel sizes left the navigation and custom panels outside the text-size preference.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const failures = [];
for (const file of walk(root)) {
  const source = readFileSync(file, "utf8");
  const patterns = file.endsWith(".tsx")
    ? [/fontSize\s*:\s*\d+(?:\.\d+)?/g, /fontSize\s*:\s*["']\d+(?:\.\d+)?px["']/g]
    : file.endsWith(".css")
      ? [/font-size\s*:\s*\d+(?:\.\d+)?px/g]
      : [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      failures.push(`${relative(root, file)}:${line}: ${match[0]}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Typography must use a named --text-* token from uikit/typography.ts.\n");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log("check-typography: all font sizes use central tokens.");
