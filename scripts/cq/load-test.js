// k6 load profile for the Configer API.
//
// It lives in the repository next to the code it exercises, which is the whole
// argument for k6 over the alternatives: the load profile is reviewable in the
// same pull request as the handler whose latency it measures.
//
// The thresholds here are k6's own, and they are deliberately generous. The
// real gate is the platform's REGRESSION budget on backend.latency.p95: an
// absolute latency threshold is a number about the runner's CPU as much as
// about the code, whereas "10% slower than the base branch, measured the same
// way on the same runner" is a statement about the change.
//
//   k6 run --summary-export summary.json scripts/cq/load-test.js
//   env: K6_BASE_URL (default http://127.0.0.1:8080)

import http from "k6/http";
import { check, group, sleep } from "k6";

const BASE = __ENV.K6_BASE_URL || "http://127.0.0.1:8080";

export const options = {
  scenarios: {
    // A short ramp rather than a fixed rate: a constant-rate scenario against a
    // cold process measures the JIT and the page cache, not the handler.
    steady: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "10s", target: 10 },
        { duration: "30s", target: 10 },
        { duration: "5s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1500"],
  },
  // The summary is the artifact; k6's own console output is not read by anybody.
  summaryTrendStats: ["avg", "min", "med", "max", "p(95)", "p(99)"],
};

export default function () {
  group("read path", () => {
    const health = http.get(`${BASE}/api/health`, { tags: { name: "health" } });
    check(health, { "health answers 200": (r) => r.status === 200 });

    // The read endpoints are what a grid over a large estate actually hits, and
    // they are the ones whose latency a user feels.
    const repos = http.get(`${BASE}/api/repos`, { tags: { name: "repos" } });
    check(repos, { "repos answers": (r) => r.status === 200 || r.status === 404 });

    const caps = http.get(`${BASE}/api/capabilities`, { tags: { name: "capabilities" } });
    check(caps, { "capabilities answers": (r) => r.status < 500 });
  });

  sleep(0.2);
}
