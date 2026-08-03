#!/usr/bin/env node
// The two boundaries that hold this codebase together, from CLAUDE.md:
//
//   "Nothing writes values outside pathedit/writeback; nothing writes .configer
//    outside writer."
//
// A boundary that is only written down is a boundary that erodes. This encodes
// something only this team knows, in 40 lines, and it is the reason the plugin
// system takes a YAML file rather than a Go interface: a check this specific
// would never be worth writing if it needed a pull request against the
// orchestrator.
//
// It is a heuristic, and it says so: confidence is medium, and every finding
// names what it saw rather than asserting a violation.
//
//   usage: node architecture-boundaries.mjs <out.json>

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";

const outPath = process.argv[2] ?? ".cq/artifacts/architecture-boundaries.json";
const root = process.env.CQ_REPO ?? process.cwd();

const RULES = [
  {
    id: "house/file-write-outside-writeback",
    // The file-writing calls that mean "this code is persisting something".
    pattern: /\b(os\.WriteFile|os\.Create|os\.OpenFile|ioutil\.WriteFile)\b/,
    // The packages whose job this is, plus the plumbing that legitimately
    // materializes trees.
    allowed: [
      "internal/writeback/", "internal/writer/", "internal/pathedit/",
      "internal/gitengine/", "internal/repobackend/", "internal/crstore/",
      "internal/store/", "internal/changeset/", "internal/workspace/",
      "internal/remoterepo/", "internal/config/",
      // layout scaffolds new instance FOLDERS, which is structure rather than
      // values, and is the one thing it exists to do.
      "internal/layout/",
    ],
    title: (rel, call) => `${rel} writes files directly (${call})`,
    detail:
      "Configuration values are written through pathedit and writeback, and nothing else. A second write path is how comment-preserving edits stop being comment-preserving.",
    recommendation:
      "Route the write through writeback (which wraps pathedit) so the edit stays surgical and the file's formatting survives.",
  },
  {
    id: "house/configer-write-outside-writer",
    pattern: /"\.configer|\.configer\/|filepath\.Join\([^)]*"\.configer"/,
    writesOnly: true,
    allowed: [
      "internal/writer/", "internal/project/", "internal/discovery/",
      "internal/config/", "internal/sources/", "internal/layout/",
    ],
    title: (rel) => `${rel} writes under .configer`,
    detail:
      "The .configer directory holds metadata only, and exactly one package writes it. Two writers means two ideas of what the metadata is.",
    recommendation:
      "Go through the writer package. If it cannot express what you need, extend it there rather than writing beside it.",
  },
];

const SKIP = new Set(["node_modules", ".git", "dist", "bin", "testdata"]);

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
    else if (e.name.endsWith(".go") && !e.name.endsWith("_test.go")) acc.push(p);
  }
  return acc;
}

const findings = [];

for (const path of walk(join(root, "backend"))) {
  const rel = relative(root, path).split("\\").join("/");
  const inPackage = rel.replace(/^backend\//, "");
  const text = readFileSync(path, "utf8");
  // Generated code is nobody's boundary to hold.
  if (/Code generated .* DO NOT EDIT/.test(text.slice(0, 500))) continue;
  const lines = text.split("\n");

  for (const rule of RULES) {
    if (rule.allowed.some((p) => inPackage.startsWith(p))) continue;

    lines.forEach((line, i) => {
      // A comment mentioning a path is not code writing to it. Without this the
      // check fires on every Swagger annotation in the API package, which is
      // the fastest way to teach people to ignore a house rule.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (!rule.pattern.test(line)) return;
      // A rule about WRITING should not fire on a line that only reads.
      if (rule.writesOnly && !/Write|Create|MkdirAll|Remove|Rename/.test(line)) return;

      const call = (line.match(rule.pattern) ?? [""])[0];
      findings.push({
        rule: rule.id,
        title: rule.title(rel, call),
        detail: rule.detail,
        severity: "warning",
        confidence: "medium",
        file: rel,
        line: i + 1,
        evidence: line.trim().slice(0, 160),
        recommendation: rule.recommendation,
        effort: "medium",
        safeToAutomate: false,
        tags: ["house-rule", "architecture"],
      });
    });
  }
}

const report = {
  findings,
  metrics: [
    {
      id: "backend.architecture.boundary_crossings",
      name: "Writes outside the packages allowed to write",
      value: findings.length,
      unit: "count",
      direction: "lower_is_better",
      category: "backend",
    },
  ],
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
process.stdout.write(`architecture-boundaries: ${findings.length} crossing(s)\n`);
