# Architecture decision records

Each record states the decision, the alternatives that were seriously
considered, the evidence, the consequences accepted, and - the part that makes
an ADR worth writing - **what would make us change our minds**.

| | Decision | Status |
|---|---|---|
| [0001](0001-orchestrator-not-framework.md) | Build an orchestrator, not another test framework | Accepted |
| [0002](0002-one-static-binary.md) | One static Go binary with near-zero dependencies | Accepted |
| [0003](0003-manifests-are-data.md) | Analyzers are data, normalizers are code | Accepted |
| [0004](0004-change-impact-selection.md) | Path scopes plus git diff, not a build graph | Accepted |
| [0005](0005-content-addressed-cache.md) | A content-addressed result cache | Accepted |
| [0006](0006-open-standards.md) | Open standards in, open standards out | Accepted |
| [0007](0007-regression-budgets.md) | Regression budgets over fixed thresholds | Accepted |
| [0008](0008-runtime-probe.md) | Build the runtime probe, buy everything else | Accepted |
| [0009](0009-otel-without-sdk.md) | OpenTelemetry wire format without the SDK | Accepted |
| [0010](0010-two-json-reports.md) | Two JSON reports: the archive and the agent contract | Accepted |
