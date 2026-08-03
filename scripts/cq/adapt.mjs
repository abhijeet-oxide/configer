#!/usr/bin/env node
// One adapter, many tools.
//
// Most tools the platform runs speak a standard the orchestrator already reads:
// SARIF, JUnit XML, LCOV, CycloneDX. A few speak only their own JSON. Rather
// than write a Go normalizer for each of those - which would mean the plugin
// system needs code, not just a manifest, every time somebody adds a tool -
// they are reshaped here into the cq native format.
//
// The rule this file exists to enforce: a FORMAT earns Go code, a TOOL earns a
// manifest. If a second tool ever speaks a format, promote it to a normalizer.
//
//   usage:  <tool> | node scripts/cq/adapt.mjs <name> > out.json

import { readFileSync } from "node:fs";

const name = process.argv[2];

const adapters = {
  // kubeconform -output json:
  //   {"resources":[{"filename","kind","name","status","msg"}],"summary":{...}}
  kubeconform(doc) {
    const findings = [];
    let invalid = 0;
    let errored = 0;
    for (const r of doc.resources ?? []) {
      const status = String(r.status ?? "").toUpperCase();
      if (status !== "STATUSINVALID" && status !== "STATUSERROR") continue;
      if (status === "STATUSINVALID") invalid++;
      else errored++;
      findings.push({
        rule: "kubeconform/" + status.toLowerCase(),
        title: `${r.kind ?? "resource"} ${r.name ?? ""} does not match its schema`.trim(),
        detail: r.msg ?? "",
        severity: status === "STATUSINVALID" ? "error" : "warning",
        file: r.filename,
        recommendation:
          "Check the apiVersion and the field names against the cluster's API version. A manifest that fails here fails at apply time too.",
        tags: ["kubernetes"],
      });
    }
    const s = doc.summary ?? {};
    return {
      findings,
      metrics: [
        m("infrastructure.k8s.invalid", "Invalid Kubernetes manifests", invalid),
        m("infrastructure.k8s.errors", "Kubernetes manifests that could not be checked", errored),
        m("infrastructure.k8s.valid", "Valid Kubernetes manifests", s.valid ?? 0, "higher_is_better"),
      ],
    };
  },

  // actionlint -format '{{json .}}':
  //   [{"message","filepath","line","column","kind","snippet"}]
  actionlint(doc) {
    const list = Array.isArray(doc) ? doc : [];
    return {
      findings: list.map((e) => ({
        rule: "actionlint/" + (e.kind ?? "workflow"),
        title: e.message,
        severity: "warning",
        file: e.filepath,
        line: e.line,
        column: e.column,
        evidence: (e.snippet ?? "").split("\n")[0],
        recommendation:
          "Fix the workflow file. A workflow runs with credentials, so a mistake here is a security problem as much as a build problem.",
        tags: ["ci"],
      })),
      metrics: [m("infrastructure.workflow.issues", "Workflow issues", list.length)],
    };
  },

  // gremlins unleash --output:
  //   {"files":[{"filename","mutations":[{"status","type","line","column"}]}]}
  gremlins(doc) {
    const findings = [];
    let killed = 0;
    let lived = 0;
    let notCovered = 0;
    for (const f of doc.files ?? []) {
      for (const mut of f.mutations ?? []) {
        const status = String(mut.status ?? "").toUpperCase();
        if (status === "KILLED") { killed++; continue; }
        if (status === "NOT COVERED" || status === "NOTCOVERED") { notCovered++; continue; }
        if (status !== "LIVED") continue;
        lived++;
        findings.push({
          rule: "gremlins/" + String(mut.type ?? "mutant").toLowerCase().replace(/\s+/g, "-"),
          title: `A ${mut.type ?? "mutation"} here survived: no test noticed the change`,
          severity: "note",
          confidence: "high",
          file: f.filename,
          line: mut.line,
          column: mut.column,
          recommendation:
            "Add an assertion that would fail if this expression were wrong. A surviving mutant is a line that is executed but not actually tested.",
          tags: ["mutation"],
        });
      }
    }
    const total = killed + lived;
    return {
      findings: findings.slice(0, 200),
      metrics: [
        m("tests.mutation.score", "Mutation score", total ? (killed / total) * 100 : 0, "higher_is_better", "percent"),
        m("tests.mutation.survived", "Surviving mutants", lived),
        m("tests.mutation.not_covered", "Mutants on uncovered code", notCovered),
      ],
    };
  },
};

function m(id, label, value, direction = "lower_is_better", unit = "count") {
  return { id, name: label, value: Number(value) || 0, unit, direction };
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const adapter = adapters[name];
if (!adapter) {
  process.stderr.write(
    `adapt.mjs: no adapter called ${name}. Known: ${Object.keys(adapters).join(", ")}\n`,
  );
  process.exit(2);
}

const raw = readStdin().trim();
// A tool that produced nothing is a clean result, not a crash. Emitting an
// empty-but-valid document is what keeps a missing artifact from being reported
// as a broken analyzer.
let parsed = {};
if (raw) {
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`adapt.mjs: ${name} did not emit valid JSON: ${err.message}\n`);
    process.stdout.write("{}\n");
    process.exit(0);
  }
}
process.stdout.write(JSON.stringify(adapter(parsed), null, 2) + "\n");
