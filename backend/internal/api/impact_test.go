package api

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/resolver"
)

// impactRepo builds a project with three instances (one production) sharing a
// global parameter, where only prod overrides it at the instance layer.
func impactRepo(t *testing.T) *project.Project {
	t.Helper()
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
	write(".configer/application.yaml", "apiVersion: configer.io/v1\nkind: Application\nname: t\nlayout: plain-folders\n")
	write(".configer/parameters.yaml", `
apiVersion: configer.io/v1
kind: ParameterCatalog
parameters:
  - id: domain
    name: platform.domain
    category: General
    type: string
    scope: global
    bindings:
      - { file: shared/platform.yaml, path: $.platform.domain, format: yaml }
      - { file: "{folder}/values.yaml", path: $.platform.domain, format: yaml }
  - id: port
    name: app.port
    category: General
    type: integer
    scope: instance
    bindings:
      - { file: "{folder}/values.yaml", path: $.app.port, format: yaml }
`)
	write(".configer/instances.yaml", `apiVersion: configer.io/v1
kind: InstanceRegistry
instances:
  - { name: staging, folder: instances/staging, environment: staging }
  - { name: prod-us, folder: instances/prod-us, environment: production }
  - { name: prod-eu, folder: instances/prod-eu, environment: production }
`)
	write("shared/platform.yaml", "platform:\n  domain: example.com\n")
	write("instances/staging/values.yaml", "app:\n  port: 8080\n")
	// prod-us overrides the shared domain at its own layer; prod-eu inherits it.
	write("instances/prod-us/values.yaml", "app:\n  port: 8443\nplatform:\n  domain: us.example.com\n")
	write("instances/prod-eu/values.yaml", "app:\n  port: 8443\n")

	p, err := project.Load(root)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// A global (shared) edit reports every instance that inherits the value, not
// just the row it appears on, and the instance that overrides it is excluded.
func TestImpactGlobalFanOut(t *testing.T) {
	p := impactRepo(t)
	rv := resolver.NewWithCatalog(p.Root, p.Catalog.Parameters)

	cr := &change.ChangeRequest{Items: []change.Item{
		{ParamID: "domain", Scope: "global", Old: "example.com", New: "corp.example.com"},
	}}
	got := computeImpact(p, rv, cr)

	if !got.Global {
		t.Error("a global edit should be marked Global")
	}
	// staging + prod-eu inherit the shared value; prod-us overrides it and is
	// excluded from the blast radius.
	if got.InstanceCount != 2 {
		t.Fatalf("instanceCount = %d (%v), want 2 (staging, prod-eu)", got.InstanceCount, got.Instances)
	}
	if !contains(got.Instances, "staging") || !contains(got.Instances, "prod-eu") || contains(got.Instances, "prod-us") {
		t.Fatalf("instances = %v, want staging + prod-eu only", got.Instances)
	}
	if !got.TouchesProduction {
		t.Error("prod-eu is production; TouchesProduction should be true")
	}
	if !contains(got.Environments, "production") || !contains(got.Environments, "staging") {
		t.Fatalf("environments = %v, want staging + production", got.Environments)
	}
}

// A per-instance edit reaches only that instance.
func TestImpactPerInstance(t *testing.T) {
	p := impactRepo(t)
	rv := resolver.NewWithCatalog(p.Root, p.Catalog.Parameters)

	cr := &change.ChangeRequest{Items: []change.Item{
		{ParamID: "port", Instance: "staging", Old: 8080, New: 9090},
	}}
	got := computeImpact(p, rv, cr)

	if got.Global {
		t.Error("a per-instance edit is not Global")
	}
	if got.InstanceCount != 1 || got.Instances[0] != "staging" {
		t.Fatalf("instances = %v, want [staging]", got.Instances)
	}
	if got.TouchesProduction {
		t.Error("a staging-only edit must not report production")
	}
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
