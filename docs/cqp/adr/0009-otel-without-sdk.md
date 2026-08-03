# ADR-0009: OpenTelemetry wire format without the SDK

**Status:** Accepted

## Context

A platform that measures other people's software and cannot answer "why did this
run take four minutes" has no standing to ask that question. The requirement is
to instrument the platform itself - execution time, cache hit rate, per-analyzer
duration, failures, parallelism - and to prefer OpenTelemetry.

The OpenTelemetry CI/CD Observability SIG landed semantic conventions for
pipelines in semconv v1.27: a SERVER span for the run, INTERNAL spans for each
task, and the `cicd.pipeline.*` attribute family.

## Decision

Emit those spans, in OTLP/JSON, **without linking the OpenTelemetry SDK**.

The output goes to `.cq/artifacts/trace.otlp.json` always, and is POSTed to a
collector when `telemetry.otlpEndpoint` is set. A collector reads it either way.

## Alternatives considered

**Link `go.opentelemetry.io/otel` and the OTLP exporter.** The correct answer for
a service. For this binary it is the wrong trade: it is a large transitive
dependency tree (`otel`, `otel/sdk`, `otel/trace`, the exporter, gRPC or the
HTTP stack, protobuf, `golang.org/x/*`) on a tool that runs in a pre-commit hook
and whose entire dependency list is currently one YAML parser. Every one of those
is also a supply-chain surface on the tool that reports supply-chain risk.

**Emit Prometheus metrics.** Wrong shape. A run is a trace: nested, causal,
bounded. A counter cannot answer "which analyzer was the long pole".

**Log lines and let the CI system correlate.** What most pipelines do, and why
nobody can answer the question.

## Consequences

- The OTLP/JSON payload is hand-built. It is about 60 lines and the format is
  stable, but a spec change is on us rather than on the SDK.
- No context propagation into child processes. An analyzer's own internal spans
  are not linked to the run's trace. Acceptable: the analyzers are third-party
  tools that do not emit spans anyway.
- Telemetry is advisory everywhere. A collector that is down may never turn a
  passing quality run into a failing one, and the CLI says so rather than
  failing.

## What would change our minds

Needing distributed context propagation - if the platform ever spawns work on
other machines, hand-rolling W3C trace context stops being reasonable and the
SDK earns its weight.
