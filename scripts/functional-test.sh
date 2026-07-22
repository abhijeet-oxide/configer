#!/usr/bin/env bash
# On-demand functional test: run Configer's scanner against the realistic
# repositories in sample-repos/ from both sides of the API.
#
#   1. Backend (Go): discovery, envelope filtering, dedup, schema validation,
#      write-back round-trips, and a synthetic large-fleet scale test.
#   2. Frontend (Node): the same repos driven through POST /api/discover,
#      asserting the JSON contract the Onboarding wizard consumes.
#
# Kept out of `make test` (which stays fast); run it when touching the scanner,
# the parsers, the layout adapters, or the sample repos. Run from anywhere.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$(mktemp -d)/configer"
trap 'rm -rf "$(dirname "$BIN")"' EXIT

echo "== building backend"
(cd "$ROOT/backend" && go build -o "$BIN" ./cmd/configer)

echo "== backend functional suite (discovery + scale)"
(cd "$ROOT/backend" && go test -tags functional ./internal/discovery/... "$@")

echo "== frontend/API functional suite"
CONFIGER_BIN="$BIN" SAMPLE_REPOS="$ROOT/sample-repos" \
  node "$ROOT/frontend/functional/discovery.test.mjs"

echo "== functional tests passed"
