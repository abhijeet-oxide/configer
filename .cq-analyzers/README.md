# Repository analyzers

Checks that are specific to this repository, layered over the platform's
built-in catalog by `analyzerDirs` in `cq.yaml`.

**Adding one is a YAML file and nothing else.** No Go code, no registration, no
rebuild of `cq`. The manifest declares which stages the check belongs to, which
changes should trigger it, how to invoke it, what format it emits, and what its
findings mean. See `docs/cqp/architecture.md` for the full contract, and
`go-file-length.yaml` here for the shortest complete example.

An analyzer here overrides a built-in one of the same id, which is how a shipped
check is retuned without forking its manifest.

## What is here

| | |
|---|---|
| `go-file-length.yaml` | The house rule from `CLAUDE.md`: Go files stay at or under ~400 lines and single-purpose. |
| `architecture-boundaries.yaml` | The two boundaries that hold this codebase together: nothing writes configuration values outside `pathedit`/`writeback`, and nothing writes `.configer` outside `writer`. |
