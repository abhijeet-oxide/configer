#!/usr/bin/env bash
# End-to-end smoke test, and the one check that proves the product's central
# promise: point Configer at a repository nobody has prepared for it, let it
# onboard itself, edit through the API, submit, and assert the review branch
# carries exactly the surgical diffs a careful engineer would have written by
# hand - and nothing else.
#
# It runs against sample-repos/telco-ran: a 5G RAN fleet with six sites, mixed
# YAML and NETCONF/YANG XML per site, a shared base file, and a JSON Schema
# beside each site's values. Nothing in it is prepared for Configer - there is
# no .configer/ folder - which is the point: ONBOARDING IS PART OF THE TEST.
# The old fixture arrived with a hand-written catalog, so the first-run path
# (the one every real user takes) was the one path this never touched.
#
# Run from anywhere.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="${SMOKE_FIXTURE:-$ROOT/sample-repos/telco-ran}"
WORK="$(mktemp -d)"
PORT="${SMOKE_PORT:-8099}"
BASE="http://localhost:${PORT}/api"
SITE="cluster-us-east-01"
OTHER="cluster-eu-west-01"
trap 'kill "${SRV_PID:-0}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

# json reads one field out of a JSON document on stdin. Node rather than a
# regex: the responses here are nested, and a sed expression that happens to
# match the wrong "id" fails in a way nobody can read.
json() { node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let v;
    try { v = JSON.parse(s); } catch { console.error("not JSON: " + s.slice(0, 200)); process.exit(1); }
    for (const k of process.argv[1].split(".")) v = v?.[k];
    console.log(v === undefined || v === null ? "" : v);
  });' "$1"; }

# put stages one value edit and echoes the HTTP status.
put() { curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/values" -d "$1"; }

cp -r "$FIXTURE" "$WORK/repo"
rm -rf "$WORK/repo/.git"
[ -e "$WORK/repo/.configer" ] && fail "the fixture already carries a .configer/ - onboarding is part of this test"

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

echo "== discover an unprepared repository"
curl -sf -X POST "$BASE/discover" -d '{}' -o "$WORK/discover.json" || fail "discovery failed"
LAYOUT=$(json detection.layout <"$WORK/discover.json")
[ "$LAYOUT" = "plain-folders" ] || fail "detected layout $LAYOUT, want plain-folders"
[ "$(json instances.length <"$WORK/discover.json")" -ge 6 ] || fail "fewer than six sites discovered"
[ "$(json parameters.length <"$WORK/discover.json")" -ge 30 ] || fail "discovery found almost no parameters"

echo "== initialize the application from the proposal"
node -e '
  const d = require(process.argv[1]);
  require("fs").writeFileSync(process.argv[2], JSON.stringify({
    name: "telco-ran", layout: d.detection.layout,
    instances: d.instances, parameters: d.parameters, author: "smoke",
  }));' "$WORK/discover.json" "$WORK/init.json"
code=$(curl -s -o "$WORK/init-result.json" -w '%{http_code}' -X POST "$BASE/init" \
  -H 'Content-Type: application/json' --data-binary @"$WORK/init.json")
[ "$code" = "201" ] || { cat "$WORK/init-result.json"; fail "init returned $code, want 201"; }

echo "== grid resolves from real files"
curl -sf "$BASE/grid" -o "$WORK/grid.json" || fail "grid failed"
grep -q "$SITE" "$WORK/grid.json" || fail "grid missing the site"
grep -q 'smo.core.example.com' "$WORK/grid.json" || fail "grid missing the shared base value"
# The XML beside the YAML is read too: one setting, two files, one row.
grep -q 'radio-unit.admin-state' "$WORK/grid.json" || fail "grid missing values read from radio.xml"

echo "== rules extracted from the schema are enforced (422)"
# Nothing below is stated in the catalog by hand: every rule here was read out
# of the site's own values.schema.json during onboarding.
[ "$(put "{\"instance\":\"$SITE\",\"paramId\":\"transport-gateway\",\"value\":\"999.1.1.1\",\"author\":\"smoke\"}")" = "422" ] \
  || fail "a malformed IPv4 address was accepted"
[ "$(put "{\"instance\":\"$SITE\",\"paramId\":\"cell-band\",\"value\":\"n99\",\"author\":\"smoke\"}")" = "422" ] \
  || fail "a band outside the schema's enum was accepted"
[ "$(put "{\"instance\":\"$SITE\",\"paramId\":\"cell-pci\",\"value\":5000,\"author\":\"smoke\"}")" = "422" ] \
  || fail "a physical cell id above the schema's maximum was accepted"
[ "$(put "{\"instance\":\"$SITE\",\"paramId\":\"cell-txpowerdbm\",\"value\":100,\"author\":\"smoke\"}")" = "422" ] \
  || fail "a transmit power above the schema's maximum was accepted"

echo "== stage a scalar edit, a fan-out edit and a global edit"
# A scalar whose line carries a trailing comment: the edit has to leave it.
[ "$(put "{\"instance\":\"$SITE\",\"paramId\":\"cell-txpowerdbm\",\"value\":35,\"author\":\"smoke\"}")" = "200" ] \
  || fail "a valid transmit power was rejected"
# One logical setting bound in TWO files of different formats. Editing it once
# has to move both, which is what makes the grid a view of the fleet rather
# than a view of one file.
[ "$(put "{\"instance\":\"$SITE\",\"paramId\":\"transport-vlan\",\"value\":200,\"author\":\"smoke\"}")" = "200" ] \
  || fail "the fan-out edit was rejected"
[ "$(put '{"scope":"global","paramId":"platform-orchestrator","value":"smo.smoke.example.com","author":"smoke"}')" = "200" ] \
  || fail "the global edit was rejected"

DRAFT=$(curl -sf "$BASE/changes/draft" | json draft.id)
[ -n "$DRAFT" ] || fail "no draft change request after staging three edits"

echo "== validate the change before it is submitted"
curl -sf -o /dev/null -X POST "$BASE/changes/$DRAFT/validation" -d '{}' || fail "could not start a validation"
for _ in $(seq 1 100); do
  curl -sf "$BASE/changes/$DRAFT/validation" -o "$WORK/validation.json" || fail "could not read the validation run"
  [ "$(json state <"$WORK/validation.json")" = "running" ] || break
  sleep 0.2
done
STATE=$(json state <"$WORK/validation.json")
[ "$STATE" = "passed" ] || { cat "$WORK/validation.json"; fail "validation ended $STATE, want passed"; }
# A repository that ships no YANG models must never be reported as having been
# checked against one. "Valid" and "nothing looked" are different answers, and
# a client that cannot tell them apart has the gate switched off without
# knowing it.
[ "$(json available <"$WORK/validation.json")" = "false" ] \
  || fail "full model validation reported available with no models in the repository"
[ -n "$(json reason <"$WORK/validation.json")" ] \
  || fail "an unavailable validator has to explain itself"

echo "== submit the draft"
SUBMITTED=$(curl -sf -X POST "$BASE/changes/$DRAFT/submit" \
  -d '{"title":"Smoke test","author":"smoke","category":"hotfix"}')
[ "$(echo "$SUBMITTED" | json state)" = "under_review" ] || fail "submit did not reach under_review"

# A branch says what kind of change it is, whose it is, and which change
# request, then the words the author used: hotfix/cr-1-smoke-test here (a
# signed-in deployment adds the author segment, hotfix/<login>/cr-1-...).
# The CR number arrives at submit, so the first submitted change is CR-1 no
# matter how many drafts were started and thrown away first.
CR_BRANCH=$(echo "$SUBMITTED" | json branch)
[ "$CR_BRANCH" = "hotfix/cr-1-smoke-test" ] \
  || fail "expected hotfix/cr-1-smoke-test, got ${CR_BRANCH:-<none>}"
[ "$(echo "$SUBMITTED" | json number)" = "1" ] || fail "submitted change did not get CR number 1"

echo "== assert the CR branch diffs"
show() { git -C "$WORK/repo" show "$CR_BRANCH:$1"; }

# The edit moved the value and left everything around it: the trailing comment
# on the same line is the thing that breaks first when a writer stops being
# surgical and starts re-emitting the document.
show "sites/$SITE/values.yaml" | grep -q 'txPowerDbm: 35 # conducted power at the antenna port' \
  || fail "the surgical edit lost the inline comment"
show "sites/$SITE/values.yaml" | grep -q 'vlan: 200 # fronthaul VLAN, must match the switch' \
  || fail "the fan-out edit missing (or comment lost) in values.yaml"
show "sites/$SITE/radio.xml" | grep -q '<vlan>200</vlan>' \
  || fail "the fan-out edit did not reach radio.xml"
show shared/platform.yaml | grep -q 'orchestrator: smo.smoke.example.com' \
  || fail "the global edit missing in the shared file"
show shared/platform.yaml | grep -q '^# Platform-wide RAN settings' \
  || fail "the global edit dropped the shared file's header comment"

# Nothing else moved. A write-back tool that regenerates is a write-back tool
# that has stopped being one.
git -C "$WORK/repo" ls-tree -r --name-only "$CR_BRANCH" | grep -q '^generated/' \
  && fail "generated/ artifacts exist - write-back regression"
show "sites/$OTHER/values.yaml" | grep -q 'vlan: 100' \
  || fail "an untouched site changed"
# .configer holds METADATA. A value appearing in it is the failure this whole
# product is arranged to prevent.
show .configer/parameters.yaml | grep -q 'smo.smoke.example.com' \
  && fail ".configer/parameters.yaml carries a VALUE - the metadata-only rule is broken"

echo "SMOKE OK"
