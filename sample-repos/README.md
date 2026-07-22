# sample-repos

A corpus of realistic GitOps configuration repositories used to exercise
Configer's scanner end to end: layout detection, instance discovery, parameter
extraction, structural-noise filtering, cross-file deduplication, and
schema-driven validation. Each repo mirrors a shape seen in the field.

These are inputs, not managed applications: none carries a `.configer/` folder.
Point Configer at any of them (`CONFIGER_REPO=sample-repos/<name>`) or run the
functional test suite, which onboards every repo and asserts the tool reads it
correctly.

| Repo | Layout | What it exercises |
|------|--------|-------------------|
| `helm-umbrella`   | plain-folders (`environments/`) | Helm chart defaults unified as the base layer under per-env overrides; `templates/`, `Chart.yaml` skipped; `values.schema.json` drives validation of instance tunables. |
| `kustomize-fleet` | kustomize (base + overlays)     | One overlay per cluster; base shared; `kustomization.yaml` skipped; strategic-merge patches with Kubernetes envelope fields filtered out. |
| `kpt-network`     | kpt (Kptfile packages)          | Setter-annotated values named after their `# kpt-set:` setter; `Kptfile` skipped; list/CIDR/IPv4 type inference. |
| `k8s-multicluster`| plain-folders (`clusters/`)     | Raw Kubernetes manifests, envelope filtering at scale, and multi-document (`---`) files addressed per document. |
| `telco-ran`       | plain-folders (`sites/`)        | Mixed YAML + NETCONF/YANG XML per site, a shared base file, list parameters, and a large parameter surface with JSON-Schema validation. |
| `helm-microservices` | Helm umbrella (aliased subcharts) | A deliberately messy probe (not part of the pass/fail suite): templated value strings, a `global:` block, list-of-maps env vars, YAML anchors, subchart-default duplication, ragged overrides, and a committed rendered manifest. Use it to see where the parameter grid stops being a faithful view. See its own README. |

## Running the checks

```bash
make functional-test          # backend (Go) + API (Node) functional suites
cd backend && go test -tags functional ./internal/discovery/...   # backend only
```

The backend suite also generates a synthetic large repo (many instances x many
parameters) in a temp directory to check the scanner's behavior and timing at
scale; nothing large is committed.
