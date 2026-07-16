#!/usr/bin/env bash
# Fails if any tracked source file contains an em-dash (U+2014).
# House rule: em-dashes are banned everywhere - code, comments, UI strings,
# commit messages, and docs. Use a spaced hyphen, a colon, or two sentences.
set -euo pipefail

cd "$(dirname "$0")/.."

# U+2014 is the bytes E2 80 94. Search tracked files only, skip this script
# (which must name the character in its own message) and vendored trees.
hits=$(git grep -n -P '\x{2014}' -- \
  ':!scripts/no-emdash.sh' \
  ':!*/node_modules/*' \
  ':!*/dist/*' 2>/dev/null || true)

if [ -n "$hits" ]; then
  echo "Em-dash (U+2014) is banned. Replace it with ' - ', a colon, or two sentences:" >&2
  echo "$hits" >&2
  exit 1
fi

echo "no-emdash: clean"
