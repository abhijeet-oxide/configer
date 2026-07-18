# Attribution

This skill is vendored from Trail of Bits' public Claude Code skills.

- Source: https://github.com/trailofbits/skills (plugin `static-analysis`, skill `semgrep`)
- Author: Trail of Bits
- License: Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0),
  full text in `LICENSE` in this directory.

Under CC BY-SA 4.0 this skill (and any adaptation of it) stays licensed CC BY-SA 4.0.

## Changes made when vendoring

- Copied only the `semgrep` skill from the upstream `static-analysis` plugin
  (the `codeql` and `sarif-parsing` skills were not vendored).
- Replaced the em-dash character (U+2014) with a spaced hyphen (" - ") throughout,
  to satisfy this repository's house rule (see `scripts/no-emdash.sh`). No other
  wording was changed.

## Requirement to run

This skill orchestrates the `semgrep` CLI; install it separately
(`pip install semgrep` or `brew install semgrep`) to actually run scans.
