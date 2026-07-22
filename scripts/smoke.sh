#!/usr/bin/env bash
# End-to-end smoke test: boot the backend on a copy of the sample fixture,
# stage edits through the API (a cell edit, a deduplicated edit, a global
# edit, an invalid value), submit the draft, and assert the CR branch carries
# exactly the expected surgical diffs. Run from the repository root.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
PORT="${SMOKE_PORT:-8099}"
BASE="http://localhost:${PORT}/api"
trap 'kill "${SRV_PID:-0}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

cp -r "$ROOT/sample-repo" "$WORK/repo"
rm -rf "$WORK/repo/.git"

echo "== building backend"
(cd "$ROOT/backend" && go build -o "$WORK/configer" ./cmd/configer)

echo "== starting backend on :$PORT"
CONFIGER_REPO="$WORK/repo" CONFIGER_DATA="$WORK/data" CONFIGER_ADDR=":$PORT" \
  CONFIGER_SYNC_SECONDS=0 "$WORK/configer" >"$WORK/server.log" 2>&1 &
SRV_PID=$!
for _ in $(seq 1 50); do
  curl -sf "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -sf "$BASE/health" >/dev/null || { cat "$WORK/server.log"; fail "backend did not start"; }

echo "== grid resolves from real files"
curl -sf "$BASE/grid" | grep -q '"telco-platform"' || fail "grid missing project"
curl -sf "$BASE/grid" | grep -q 'datastore.use1.demo.local' || fail "grid missing instance value"

echo "== invalid value is rejected (422)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/values" \
  -d '{"instance":"prod-us-east","paramId":"gateway-address","value":"999.1.1.1","author":"smoke"}')
[ "$code" = "422" ] || fail "invalid value returned $code, want 422"

echo "== a CPU limit below its request is rejected (cross-field rule)"
# prod-us-east requests 500m; a 100m limit is below it and must be refused.
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/values" \
  -d '{"instance":"prod-us-east","paramId":"res-limit-cpu","value":"100m","author":"smoke"}')
[ "$code" = "422" ] || fail "cpu limit below request returned $code, want 422"
# A malformed CPU quantity is refused by the type itself.
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/values" \
  -d '{"instance":"prod-us-east","paramId":"res-limit-cpu","value":"lots","author":"smoke"}')
[ "$code" = "422" ] || fail "malformed cpu quantity returned $code, want 422"
# A valid limit at or above the request is accepted.
curl -sf -X PUT "$BASE/values" \
  -d '{"instance":"prod-us-east","paramId":"res-limit-cpu","value":"1500m","author":"smoke"}' >/dev/null \
  || fail "valid cpu limit 1500m was rejected"

echo "== stage cell edit + dedup edit + global edit"
curl -sf -X PUT "$BASE/values" -d '{"instance":"prod-us-east","paramId":"datastore-port","value":5533,"author":"smoke"}' >/dev/null
curl -sf -X PUT "$BASE/values" -d '{"instance":"prod-us-east","paramId":"namespace","value":"telco-prod-smoke","author":"smoke"}' >/dev/null
curl -sf -X PUT "$BASE/values" -d '{"scope":"global","paramId":"platform-domain","value":"smoke.example.com","author":"smoke"}' >/dev/null

echo "== submit the draft"
curl -sf -X POST "$BASE/changes/1/submit" -d '{"title":"Smoke test","author":"smoke"}' | grep -q under_review \
  || fail "submit did not reach under_review"

# The change request is named for its title: "Smoke test" -> feature/smoke-test.
CR_BRANCH="feature/smoke-test"

echo "== assert the CR branch diffs"
show() { git -C "$WORK/repo" show "$CR_BRANCH:$1"; }
show instances/prod-us-east/values.yaml | grep -q 'port: 5533 # postgres wire protocol' \
  || fail "surgical edit lost the inline comment"
show instances/prod-us-east/values.yaml | grep -q 'namespace: telco-prod-smoke' \
  || fail "dedup edit missing in values.yaml"
show instances/prod-us-east/network.xml | grep -q 'namespace="telco-prod-smoke"' \
  || fail "dedup edit did not fan out to network.xml"
show shared/platform.yaml | grep -q 'domain: smoke.example.com' \
  || fail "global edit missing in shared file"
git -C "$WORK/repo" ls-tree -r --name-only "$CR_BRANCH" | grep -q '^generated/' \
  && fail "generated/ artifacts exist - write-back regression"
show instances/prod-eu-west/values.yaml | grep -q 'datastore.euw1.demo.local' \
  || fail "untouched instance changed"

echo "SMOKE OK"
