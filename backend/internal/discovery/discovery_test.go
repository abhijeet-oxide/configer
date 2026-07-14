package discovery

import (
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/layout"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/parsers"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

func registry() *plugin.Registry {
	reg := plugin.NewRegistry()
	parsers.Register(reg)
	return reg
}

func paramsByName(res Result) map[string]model.Parameter {
	m := map[string]model.Parameter{}
	for _, p := range res.Parameters {
		m[p.Name] = p
	}
	return m
}

// The plain fixture (../layout/testdata/plain) is the discovery contract:
// two instances, a shared file, a namespace repeated across YAML and XML,
// and a JSON Schema next to prod's values.yaml.
func TestDiscoverPlainFolders(t *testing.T) {
	res, err := Discover("../layout/testdata/plain", registry(), project.Ignore{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Detection.Layout != layout.KindPlainFolders {
		t.Fatalf("layout = %s", res.Detection.Layout)
	}
	if len(res.Instances) != 2 || res.Instances[1].Folder != "instances/prod" {
		t.Fatalf("instances = %+v", res.Instances)
	}

	byName := paramsByName(res)

	// namespace exists in values.yaml AND net.xml with identical per-instance
	// values -> ONE parameter with TWO templated bindings.
	ns, ok := byName["namespace"]
	if !ok {
		t.Fatal("namespace parameter missing")
	}
	if len(ns.Bindings) != 2 {
		t.Fatalf("namespace bindings = %+v, want 2 (values.yaml + net.xml)", ns.Bindings)
	}
	for _, b := range ns.Bindings {
		if b.EffectiveLayer() != model.LayerInstance {
			t.Errorf("namespace binding %s should be instance layer", b.File)
		}
	}

	// app.port differs per instance -> instance-scoped, templated, no default.
	port, ok := byName["app.port"]
	if !ok {
		t.Fatal("app.port parameter missing")
	}
	if port.Bindings[0].File != "{folder}/values.yaml" {
		t.Errorf("port binding = %+v", port.Bindings[0])
	}
	if port.Default != nil {
		t.Errorf("port default = %v, want none (values differ)", port.Default)
	}

	// The schema next to prod's values.yaml supplies validation.
	if port.Type != model.TypeInteger || port.Validation.Min == nil || *port.Validation.Max != 65535 {
		t.Errorf("port schema validation not attached: %+v", port.Validation)
	}
	if !ns.Validation.Required || ns.Validation.Pattern == "" {
		t.Errorf("namespace schema validation not attached: %+v", ns.Validation)
	}
	if ns.Validation.SchemaRef == "" {
		t.Error("namespace schemaRef missing")
	}

	// The shared file's setting is a global parameter with a literal binding.
	dom, ok := byName["platform.domain"]
	if !ok {
		t.Fatal("platform.domain parameter missing")
	}
	if dom.Scope != model.ScopeGlobal || dom.Bindings[0].File != "shared/platform.yaml" {
		t.Errorf("platform.domain = %+v", dom)
	}
	if dom.Default != "example.com" {
		t.Errorf("platform.domain default = %v", dom.Default)
	}
}

func TestDiscoverKptSetters(t *testing.T) {
	res, err := Discover("../layout/testdata/kpt", registry(), project.Ignore{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Detection.Layout != layout.KindKpt {
		t.Fatalf("layout = %s", res.Detection.Layout)
	}
	byName := paramsByName(res)
	rep, ok := byName["app.replicas"]
	if !ok {
		t.Fatal("app.replicas missing")
	}
	if rep.DisplayName != "replicas" {
		t.Errorf("displayName = %q, want kpt setter name", rep.DisplayName)
	}
	if rep.Bindings[0].File != "{folder}/config.yaml" {
		t.Errorf("binding = %+v", rep.Bindings[0])
	}
}

func TestDiscoverKustomize(t *testing.T) {
	res, err := Discover("../layout/testdata/kustomize", registry(), project.Ignore{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Detection.Layout != layout.KindKustomize {
		t.Fatalf("layout = %s", res.Detection.Layout)
	}
	byName := paramsByName(res)
	// spec.replicas appears in every overlay's patch.yaml -> one templated param.
	rep, ok := byName["spec.replicas"]
	if !ok {
		t.Fatalf("spec.replicas missing; have %v", keys(byName))
	}
	if rep.Bindings[0].File != "{folder}/patch.yaml" {
		t.Errorf("binding = %+v", rep.Bindings[0])
	}
	// Base files land on the shared layer.
	if _, ok := byName["spec.replicas"]; !ok {
		t.Error("overlay param missing")
	}
}

func keys(m map[string]model.Parameter) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}
