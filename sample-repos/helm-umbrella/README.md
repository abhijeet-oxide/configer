# helm-umbrella (sample repo)

A Helm umbrella chart deployed to several environments. The chart's own
`values.yaml` holds fleet defaults; each `environments/<env>/values.yaml`
overrides only what that environment changes. A `values.schema.json` next to
the chart defaults drives validation.

Configer view:
- layout: plain-folders (one folder per environment under `environments/`)
- base layer: `charts/platform/values.yaml` (chart defaults)
- instance layer: `environments/<env>/values.yaml`
- skipped: `Chart.yaml`, `templates/` (Go-templated manifests), the schema file
