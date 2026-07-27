package api

import (
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// restoreProject is a two-instance app with one per-instance parameter, one
// parameter bound only on a single instance, and one shared/global parameter.
func restoreProject() *project.Project {
	return &project.Project{
		Root: "/tmp",
		Catalog: model.Catalog{Parameters: []model.Parameter{
			{
				ID: "port", Name: "app.port", Type: "integer", Scope: model.ScopeInstance,
				Bindings: []model.Binding{{File: "{folder}/values.yaml", Path: "$.app.port", Format: "yaml"}},
			},
			{
				// Bound to a file that only prod's folder token expands into, but
				// the binding is instance-layer, so both instances carry it.
				ID: "replicas", Name: "app.replicas", Type: "integer", Scope: model.ScopeInstance,
				Bindings: []model.Binding{{File: "{folder}/values.yaml", Path: "$.app.replicas", Format: "yaml"}},
			},
			{
				ID: "timeout", Name: "shared.timeout", Type: "integer", Scope: model.ScopeGlobal,
				Bindings: []model.Binding{{File: "shared/base.yaml", Path: "$.timeout", Format: "yaml", Layer: "base"}},
			},
		}},
		Registry: model.InstanceRegistry{Instances: []model.Instance{
			{Name: "prod", Folder: "instances/prod"},
			{Name: "dev", Folder: "instances/dev"},
		}},
	}
}

// Instance scope must expand to exactly that instance's own cells - the
// selective-rollback case: roll back one instance out of a fleet-wide change
// without touching its siblings.
func TestRestoreTargetsInstanceScope(t *testing.T) {
	p := restoreProject()
	targets, notFound := restoreTargets(p, restoreRequest{Scope: "instance", Instance: "prod"})
	if notFound != "" {
		t.Fatalf("unexpected not-found: %s", notFound)
	}
	if len(targets) != 2 {
		t.Fatalf("got %d targets, want 2 (the instance-layer parameters)", len(targets))
	}
	for _, tg := range targets {
		if tg.instance != "prod" {
			t.Errorf("target %s is on %q, want prod only", tg.param.ID, tg.instance)
		}
		if tg.global {
			t.Errorf("target %s must not be global in instance scope", tg.param.ID)
		}
	}
}

// Parameter scope resolves one cell, and a global parameter resolves to the
// shared value even when no instance is named.
func TestRestoreTargetsParameterScope(t *testing.T) {
	p := restoreProject()

	targets, notFound := restoreTargets(p, restoreRequest{Scope: "parameter", ParamID: "port", Instance: "dev"})
	if notFound != "" || len(targets) != 1 {
		t.Fatalf("got %d targets (%q), want exactly 1", len(targets), notFound)
	}
	if targets[0].param.ID != "port" || targets[0].instance != "dev" {
		t.Errorf("target = %s on %q, want port on dev", targets[0].param.ID, targets[0].instance)
	}

	// A global parameter with no instance named restores the shared value.
	targets, notFound = restoreTargets(p, restoreRequest{Scope: "parameter", ParamID: "timeout"})
	if notFound != "" || len(targets) != 1 {
		t.Fatalf("global: got %d targets (%q), want 1", len(targets), notFound)
	}
	if !targets[0].global {
		t.Error("a global-scope parameter must produce a global target")
	}
}

// The whole-application scope covers every instance cell plus every shared
// value, each exactly once.
func TestRestoreTargetsAllScope(t *testing.T) {
	p := restoreProject()
	targets, notFound := restoreTargets(p, restoreRequest{Scope: "all"})
	if notFound != "" {
		t.Fatalf("unexpected not-found: %s", notFound)
	}
	// 2 instance parameters x 2 instances, plus 1 global.
	if len(targets) != 5 {
		t.Fatalf("got %d targets, want 5", len(targets))
	}
	globals := 0
	seen := map[string]bool{}
	for _, tg := range targets {
		if tg.global {
			globals++
			continue
		}
		key := tg.param.ID + "|" + tg.instance
		if seen[key] {
			t.Errorf("duplicate target %s", key)
		}
		seen[key] = true
	}
	if globals != 1 {
		t.Errorf("got %d global targets, want 1", globals)
	}
}

// Unknown instances and parameters are reported as plain not-found messages,
// never as a silent empty restore.
func TestRestoreTargetsNotFound(t *testing.T) {
	p := restoreProject()
	if _, notFound := restoreTargets(p, restoreRequest{Scope: "instance", Instance: "nope"}); notFound == "" {
		t.Error("an unknown instance must report not-found")
	}
	if _, notFound := restoreTargets(p, restoreRequest{Scope: "parameter", ParamID: "nope", Instance: "prod"}); notFound == "" {
		t.Error("an unknown parameter must report not-found")
	}
	if _, notFound := restoreTargets(p, restoreRequest{Scope: "parameter", ParamID: "port", Instance: "nope"}); notFound == "" {
		t.Error("a known parameter on an unknown instance must report not-found")
	}
}
