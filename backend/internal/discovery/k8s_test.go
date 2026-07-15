package discovery

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// TestDiscoverK8sManifestFilter checks that Kubernetes envelope fields
// (apiVersion, kind, metadata bookkeeping, status) are NOT imported as
// parameters from a manifest file, while real values (spec.replicas, and a
// sibling Helm values file's fields) are kept.
func TestDiscoverK8sManifestFilter(t *testing.T) {
	root := t.TempDir()
	write := func(rel, content string) {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// A Kubernetes Deployment manifest under one instance.
	write("instances/site-a/deploy.yaml", `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: prod
  labels:
    app: web
  annotations:
    note: hello
spec:
  replicas: 3
  minReadySeconds: 10
status:
  readyReplicas: 3
`)
	// A plain Helm values file: everything here is configuration.
	write("instances/site-a/values/app/values.yaml", `image:
  tag: v1.2.3
name: web
namespace: prod
`)

	res, err := Discover(root, registry(), project.Ignore{})
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, p := range res.Parameters {
		names[p.Name] = true
	}

	// Manifest envelope must be gone.
	for _, dropped := range []string{"apiVersion", "kind", "metadata.name", "metadata.namespace", "metadata.labels.app", "metadata.annotations.note", "status.readyReplicas"} {
		if names[dropped] {
			t.Errorf("k8s envelope field %q should not be imported", dropped)
		}
	}
	// Real spec values from the manifest must remain.
	for _, kept := range []string{"spec.replicas", "spec.minReadySeconds"} {
		if !names[kept] {
			t.Errorf("configurable field %q should be imported", kept)
		}
	}
	// The plain values file is untouched — "name"/"namespace" there are config.
	for _, kept := range []string{"image.tag", "name", "namespace"} {
		if !names[kept] {
			t.Errorf("values-file field %q should be imported", kept)
		}
	}
}
