// Functional test (frontend contract): boot the Configer backend against every
// repo in sample-repos/ and drive POST /api/discover exactly as the Onboarding
// wizard does, asserting the JSON the frontend consumes (detection.layout,
// instances[], parameters[] with bindings and validation, skipped[]). This is
// the browser-facing counterpart to the backend Go functional suite; together
// they pin the tool's behavior on realistic repos from both sides of the API.
//
// Run standalone (builds the backend if needed):
//   node functional/discovery.test.mjs
// or via the repo harness:
//   make functional-test
//
// Env:
//   CONFIGER_BIN   path to a prebuilt backend binary (optional; built if unset)
//   SAMPLE_REPOS   path to the sample-repos dir (default: ../sample-repos)

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const sampleRepos = process.env.SAMPLE_REPOS || join(repoRoot, "sample-repos");

// Expectations per repo, mirroring the backend functional suite. Kept in the
// frontend so a contract drift (renamed field, dropped validation) fails here.
const cases = [
  {
    name: "helm-umbrella",
    layout: "plain-folders",
    minInstances: 4,
    instance: "prod-us",
    present: ["replicaCount", "image.tag", "service.port", "service.type", "resources.limits.cpu", "resources.requests.memory"],
    absent: ["version", "appVersion", "apiVersion", "dependencies.name"],
    validated: { "service.type": (v) => (v.enum || []).length > 0, "replicaCount": (v) => v.min != null && v.max != null },
    // resource quantities are typed and the limit is bound to at least its request.
    resourcePairs: true,
  },
  {
    name: "kustomize-fleet",
    layout: "kustomize",
    minInstances: 5,
    instance: "prod-us-east",
    present: ["spec.replicas", "spec.type", "data.LOG_LEVEL"],
    absent: ["apiVersion", "kind", "metadata.name"],
  },
  {
    name: "kpt-network",
    layout: "kpt",
    minInstances: 4,
    instance: "us-east",
    present: ["spec.replicas", "spec.routing.subnet", "spec.dns"],
    absent: ["apiVersion", "kind", "metadata.name"],
  },
  {
    name: "k8s-multicluster",
    layout: "plain-folders",
    minInstances: 5,
    instance: "us-east-1",
    present: ["spec.replicas", "spec.type", "data.LOG_LEVEL"],
    absent: ["apiVersion", "kind", "metadata.name", "status.readyReplicas"],
    // The Service lives in the second document of a multi-doc bundle.yaml.
    multiDoc: "spec.type",
  },
  {
    name: "telco-ran",
    layout: "plain-folders",
    minInstances: 6,
    instance: "cluster-us-east-01",
    present: ["cell.band", "cell.earfcn", "transport.gateway", "radio-unit.admin-state"],
    validated: { "cell.band": (v) => (v.enum || []).length > 0, "transport.gateway": (v) => v.preset === "ipv4" },
  },
];

function buildBackend() {
  const bin = join(mkdtempSync(join(tmpdir(), "configer-fn-")), "configer");
  const r = spawnSync("go", ["build", "-o", bin, "./cmd/configer"], {
    cwd: join(repoRoot, "backend"),
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("backend build failed");
  return bin;
}

async function waitHealthy(port, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("backend did not become healthy");
}

async function discover(bin, repoPath, port, dataDir) {
  const srv = spawn(bin, [], {
    env: {
      ...process.env,
      CONFIGER_REPO: repoPath,
      CONFIGER_DATA: dataDir,
      CONFIGER_ADDR: `:${port}`,
      CONFIGER_SYNC_SECONDS: "0",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    await waitHealthy(port);
    const res = await fetch(`http://127.0.0.1:${port}/api/discover`, { method: "POST" });
    if (!res.ok) throw new Error(`/api/discover -> ${res.status}`);
    return await res.json();
  } finally {
    srv.kill("SIGKILL");
  }
}

function byName(disc) {
  const m = new Map();
  for (const p of disc.parameters || []) m.set(p.name, p);
  return m;
}

let failures = 0;
const fail = (repo, msg) => {
  failures++;
  console.error(`  FAIL [${repo}] ${msg}`);
};

async function main() {
  if (!existsSync(sampleRepos)) throw new Error(`sample-repos not found at ${sampleRepos}`);
  const bin = process.env.CONFIGER_BIN || buildBackend();
  const dataRoot = mkdtempSync(join(tmpdir(), "configer-fn-data-"));

  let port = 8300;
  for (const c of cases) {
    // Serve out of a throwaway copy: the backend runs `git init` on the repo it
    // manages, so pointing it at the committed sample would dirty the tree.
    const repoPath = join(dataRoot, `${c.name}-repo`);
    cpSync(join(sampleRepos, c.name), repoPath, { recursive: true });
    process.stdout.write(`- ${c.name} ... `);
    let disc;
    try {
      disc = await discover(bin, repoPath, port++, join(dataRoot, c.name));
    } catch (e) {
      fail(c.name, `discover threw: ${e.message}`);
      console.log("");
      continue;
    }

    if (disc.detection?.layout !== c.layout) fail(c.name, `layout=${disc.detection?.layout}, want ${c.layout}`);
    const insts = disc.instances || [];
    if (insts.length < c.minInstances) fail(c.name, `instances=${insts.length}, want >= ${c.minInstances}`);
    if (!insts.some((i) => i.name === c.instance)) fail(c.name, `instance ${c.instance} missing`);

    const params = byName(disc);
    for (const n of c.present || []) if (!params.has(n)) fail(c.name, `missing parameter ${n}`);
    for (const n of c.absent || []) if (params.has(n)) fail(c.name, `noise parameter ${n} present`);
    for (const [n, pred] of Object.entries(c.validated || {})) {
      const p = params.get(n);
      if (!p) fail(c.name, `validated parameter ${n} missing`);
      else if (!pred(p.validation || {})) fail(c.name, `validation on ${n} not attached: ${JSON.stringify(p.validation)}`);
    }
    // Every parameter must carry at least one binding the frontend can render.
    for (const p of disc.parameters || []) {
      if (!p.bindings || p.bindings.length === 0) fail(c.name, `parameter ${p.name} has no bindings`);
    }
    // Multi-document contract: the marked parameter's binding path must carry a
    // "[N]$" document selector, proving the second document was read.
    if (c.multiDoc) {
      const p = params.get(c.multiDoc);
      const sel = p?.bindings?.some((b) => /^\[\d+\]\$/.test(b.path));
      if (!sel) fail(c.name, `${c.multiDoc} should have a multi-document selector binding`);
    }
    // Kubernetes resource quantities: cpu/memory typed, limit linked to request.
    if (c.resourcePairs) {
      const lim = [...params.values()].find((p) => /limits\.cpu$/.test(p.name));
      const req = [...params.values()].find((p) => /requests\.cpu$/.test(p.name));
      if (!lim || lim.type !== "cpu") fail(c.name, `cpu limit not typed as cpu (got ${lim?.type})`);
      if (!req || req.type !== "cpu") fail(c.name, `cpu request not typed as cpu (got ${req?.type})`);
      if (lim && req && lim.validation?.atLeast !== req.id)
        fail(c.name, `cpu limit not linked atLeast the request (got ${lim.validation?.atLeast})`);
      const mlim = [...params.values()].find((p) => /limits\.memory$/.test(p.name));
      if (!mlim || mlim.type !== "memory") fail(c.name, `memory limit not typed as memory (got ${mlim?.type})`);
    }

    console.log(`ok (${c.layout}, ${insts.length} instances, ${disc.parameters?.length ?? 0} params)`);
  }

  if (failures) {
    console.error(`\nFUNCTIONAL API TESTS FAILED: ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log("\nAll API functional checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
