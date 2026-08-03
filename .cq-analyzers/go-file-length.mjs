#!/usr/bin/env node
// The house rule from CLAUDE.md, measured:
//
//   "Keep Go files <= ~400 lines and single-purpose; split by resource, not by
//    layer."
//
// Emits the cq native format, so the orchestrator needs no knowledge of it.
//
//   usage: node go-file-length.mjs <out.json>

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";

const outPath = process.argv[2] ?? ".cq/artifacts/go-file-length.json";
const root = process.env.CQ_REPO ?? process.cwd();

// The guideline is ~400, so warn at the guideline and escalate well past it. A
// check that fires at 401 lines is a check people learn to ignore.
const LIMIT = Number(process.env.CQ_GO_FILE_LIMIT ?? 400);
const HARD = LIMIT * 1.5;

const ROOTS = ["backend", "quality"];
const SKIP = new Set(["node_modules", ".git", "dist", "bin", "testdata", ".cq"]);

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".go")) acc.push(p);
  }
  return acc;
}

const findings = [];
let over = 0;
let total = 0;
let longest = 0;

for (const dir of ROOTS) {
  for (const path of walk(join(root, dir))) {
    // Generated files are not anybody's to split. The header is matched
    // loosely because swaggo omits the trailing full stop that the convention
    // in go/build asks for, and a check that misses the largest generated file
    // in the tree is worse than useless.
    const text = readFileSync(path, "utf8");
    if (/Code generated .* DO NOT EDIT/.test(text.slice(0, 500))) continue;

    total++;
    const lines = text.split("\n").length;
    longest = Math.max(longest, lines);
    if (lines <= LIMIT) continue;
    over++;

    const rel = relative(root, path).split("\\").join("/");
    // A test file legitimately grows with the number of cases it covers, so it
    // is held to the guideline more loosely than the code it tests.
    const isTest = rel.endsWith("_test.go");
    findings.push({
      rule: "house/go-file-length",
      title: `${rel} is ${lines} lines, over the ${LIMIT}-line guideline`,
      detail:
        "CLAUDE.md asks for Go files at or under ~400 lines and single-purpose, split by resource rather than by layer.",
      severity: lines > HARD && !isTest ? "warning" : "note",
      confidence: "high",
      file: rel,
      line: LIMIT,
      recommendation: isTest
        ? "A long test file is usually several suites in one. Split it by the resource under test."
        : "Look for the second responsibility in this file and give it its own. Splitting by resource keeps the seams where the domain already has them.",
      effort: "medium",
      safeToAutomate: false,
      tags: ["house-rule", "maintainability"],
    });
  }
}

// Sort worst first so the report's cap keeps the ones that matter.
findings.sort((a, b) => b.title.localeCompare(a.title));

const report = {
  findings,
  metrics: [
    {
      id: "general.go_files.over_limit",
      name: `Go files over ${LIMIT} lines`,
      value: over,
      unit: "count",
      direction: "lower_is_better",
      category: "general",
    },
    {
      id: "general.go_files.longest",
      name: "Longest Go file",
      value: longest,
      unit: "count",
      direction: "lower_is_better",
      category: "general",
    },
    {
      id: "general.go_files.total",
      name: "Go files",
      value: total,
      unit: "count",
      direction: "higher_is_better",
      category: "general",
    },
  ],
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
process.stdout.write(`go-file-length: ${over} of ${total} file(s) over ${LIMIT} lines\n`);
