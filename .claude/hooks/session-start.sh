#!/bin/bash
# SessionStart hook: make Graphify available in Claude Code on the web sessions.
#
# Graphify (https://github.com/safishamsi/graphify) builds a queryable knowledge
# graph of the repo so the assistant can navigate by structure instead of
# re-reading files. Its skill and CLI live under ~/.claude and ~/.local, both of
# which are ephemeral in a remote container, so we reinstall them on every
# remote session start. This only installs the tool; run `/graphify .` yourself
# to build or refresh the graph (that step is heavier and uses the model).
set -euo pipefail

# Web (remote) sessions only; local machines manage their own tooling.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Idempotent: a no-op once the package is already present, so it stays fast when
# the container state is cached across resumes. Best-effort - a network blip must
# not block the session from starting.
if ! python3 -m pip install --user --quiet graphifyy; then
  echo "graphify: pip install failed; skipping (run 'pip install --user graphifyy' by hand)" >&2
  exit 0
fi

# The CLI installs to the user-site bin; put it on PATH for this run and persist
# it for the rest of the session so `graphify` resolves.
export PATH="$HOME/.local/bin:$PATH"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
fi

# Registers the /graphify skill into ~/.claude (recreated each ephemeral session).
if ! graphify install; then
  echo "graphify: 'graphify install' failed; /graphify may be unavailable this session" >&2
fi
