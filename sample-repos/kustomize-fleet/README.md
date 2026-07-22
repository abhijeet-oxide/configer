# kustomize-fleet (sample repo)

A Kustomize base + overlays repo: one shared `base/` and one overlay per
cluster under `overlays/`. Overlays carry strategic-merge patches that tune
replica counts, resource limits and app config per cluster.

Configer view:
- layout: kustomize (each overlay is one instance; base/ is shared)
- skipped: `kustomization.yaml` files (they are build wiring, not values)
- Kubernetes envelope fields (apiVersion/kind/metadata/status) are dropped;
  only tunable spec/data values become parameters.
