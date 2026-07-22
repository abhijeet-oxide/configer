# k8s-multicluster (sample repo)

Raw Kubernetes manifests, one folder per cluster under `clusters/`. Each
cluster has a Deployment, an HPA, and a multi-document `bundle.yaml` that packs
a ConfigMap and a Service in one file (the "---" convention). Configer reads
and writes individual documents inside multi-document files.

Configer view:
- layout: plain-folders (one folder per cluster under `clusters/`)
- Kubernetes envelope fields (apiVersion/kind/metadata/status) are dropped;
  spec/data tunables are kept.
- multi-document files: each document is addressed with a "[N]$..." selector.
