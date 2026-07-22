# helm-microservices (deliberately messy)

An umbrella Helm chart that intentionally reproduces the real-world patterns a
clean fixture leaves out, to probe where a parameter x instance grid stops
being a faithful view of the config. Point Configer at it:

```bash
make backend CONFIGER_REPO=./sample-repos/helm-microservices
```

## What makes it hard (and what to check the grid does with each)

| Pattern | Where | The abstraction risk |
|---------|-------|----------------------|
| Aliased subchart (`postgresql` as `db`) + a `global:` block | `Chart.yaml`, `values.yaml` | Values live under alias keys and a shared `global` that fans out to every subchart at render time. Is `global.namespace` one row or many? |
| Same setting in three files | `charts/api/values.yaml`, umbrella `values.yaml`, `environments/*/values.yaml` | `api.replicaCount` is a chart default, an umbrella override, and a per-env override. Does dedup unify them or triple-count them? |
| Autoscaling makes `replicaCount` inert | `charts/api/templates/deployment.yaml` (`{{- if not .Values.autoscaling.enabled }}`) | In prod the effective replica count comes from `autoscaling.minReplicas`, not `replicaCount`. A per-cell value cannot express "this cell is dead because another cell is on." |
| Value that exists only in a template | `deployment.yaml` `readinessProbe.timeoutSeconds: 3` | A genuinely tunable production value with no `values.yaml` key. Invisible to a values-file-driven grid. |
| Templated value strings | `values.yaml` `api.env[].value: "{{ .Release.Name }}-db"`, `ingress.host: "api.{{ .Values.global.domain }}"` | The stored value is a Helm expression, not the effective value. Editing it as a literal would corrupt the template. |
| List-of-maps env vars | `values.yaml` / `environments/*` `api.env` | `env` is a list of `{name,value}` objects. There is no single scalar cell for "LOG_LEVEL"; it is addressed by list position or by a `[name=LOG_LEVEL]` selector. |
| YAML anchors / aliases | `values.yaml` `&probes`, `prod-us/values.yaml` `&prodres` / `*prodres` | A surgical editor must not expand or break `*prodres`; editing one cell must not silently rewrite the anchor for the other consumer. |
| Ragged environment overrides | `environments/dev` omits most keys; `db.enabled: false` | Columns are sparse: most dev cells resolve to a chart default, and an entire subchart (db) is off. Does the grid show default-provenance vs a real per-env value honestly? |
| Committed rendered output | `rendered/prod-us.yaml` | A generated manifest checked in beside its source: a second copy of the same values that drifts. Should be ignored, never treated as an editable instance. |

This repo has no `.configer/`; onboarding must decide all of the above.
