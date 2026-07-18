#!/bin/bash
# SessionStart hook: provision the repo-committed skills' runtime tools in
# Claude Code on the web sessions. These tools live under ephemeral ~/.claude
# and ~/.local, so they are (re)installed on every remote session start.
#
#   - Graphify: builds a code knowledge graph for the /graphify skill.
#   - Semgrep:  static-analysis CLI for the vendored `semgrep` skill.
#
# Each block is best-effort and independent: a network blip or one tool failing
# must never block the session from starting, nor stop the others from setting
# up. Only the model-free, zero-token work happens here; building semantic doc
# graphs or running scans stays on-demand.
set -euo pipefail

# Web (remote) sessions only; local machines manage their own tooling.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# The user-site bin holds the CLIs; put it on PATH for this run and persist it
# for the rest of the session so `graphify` and `semgrep` resolve.
export PATH="$HOME/.local/bin:$PATH"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
fi

# --- Graphify: knowledge-graph builder (the /graphify skill) ---------------
# Idempotent, and a no-op once cached, so it stays fast on resumes.
if python3 -m pip install --user --quiet graphifyy; then
  # Registers the /graphify skill into ~/.claude (recreated each session).
  graphify install \
    || echo "graphify: 'graphify install' failed; /graphify may be unavailable this session" >&2
  # Build/refresh the code graph now. `graphify update` is pure tree-sitter AST
  # extraction - no model, no tokens - and incremental, re-reading only changed
  # files. The graph lives in the gitignored graphify-out/, rebuilt each session
  # rather than committed.
  graphify update "${CLAUDE_PROJECT_DIR:-.}" >/dev/null 2>&1 \
    || echo "graphify: graph build skipped; run '/graphify .' by hand this session" >&2
else
  echo "graphify: pip install failed; run 'pip install --user graphifyy' by hand" >&2
fi

# --- Semgrep: static-analysis scanner (the vendored `semgrep` skill) --------
# Install only if it is not already working. Semgrep's native cffi backend
# sometimes needs a user-site (re)install before it will load, so retry that
# once if the version check fails after install.
if ! semgrep --version >/dev/null 2>&1; then
  python3 -m pip install --user --quiet semgrep >/dev/null 2>&1 || true
  semgrep --version >/dev/null 2>&1 \
    || python3 -m pip install --user --quiet --force-reinstall cffi >/dev/null 2>&1 || true
fi
semgrep --version >/dev/null 2>&1 \
  || echo "semgrep: unavailable this session (run 'pip install --user semgrep cffi')" >&2
