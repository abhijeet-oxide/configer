package api

// Blast radius: how far a change request actually reaches. A shared (global /
// base-layer) edit is written once but changes the effective value for every
// instance that inherits it, so the reviewer must see the true fan-out - "this
// changes 12 instances across staging and production" - not just the single row
// the edit appears on. Impact resolves that fan-out through the effective-value
// chain and travels on every change response so the approval surface can lead
// with reach and highlight production.

import (
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/resolver"
)

// Impact is a change request's blast radius.
type Impact struct {
	// Instances are the instance names the change effectively alters (including
	// those a shared edit fans out to), sorted.
	Instances     []string `json:"instances"`
	InstanceCount int      `json:"instanceCount"`
	// Environments are the distinct environments those instances live in, sorted.
	Environments []string `json:"environments"`
	// TouchesProduction flags any production instance in the blast radius, so the
	// approval surface can weight the decision.
	TouchesProduction bool `json:"touchesProduction"`
	// Global is true when the change includes a shared (base-layer) edit whose
	// reach is the fleet, not a single instance.
	Global bool `json:"global"`
}

// changeResponse is a change request plus its computed blast radius. The
// embedded pointer flattens the CR's own fields at the top level, so the
// response is the change request the client already knows, with `impact` added.
type changeResponse struct {
	*change.ChangeRequest
	Impact Impact `json:"impact"`
}

// withImpact wraps a change request with its blast radius for a response.
func withImpact(p *project.Project, cr *change.ChangeRequest) changeResponse {
	rv := resolver.NewWithCatalog(p.Root, p.Catalog.Parameters)
	return changeResponse{ChangeRequest: cr, Impact: computeImpact(p, rv, cr)}
}

// computeImpact walks a change request's items and returns its blast radius. A
// per-instance edit reaches its own instance; a shared (global) edit reaches
// every instance that still inherits the parameter from the base layer - an
// instance that overrides it at its own layer is unaffected by the shared edit,
// so it is not counted. The resolver is passed in so a list can reuse one
// document cache across many change requests.
func computeImpact(p *project.Project, rv *resolver.Resolver, cr *change.ChangeRequest) Impact {
	affected := map[string]bool{}
	global := false
	mark := func(name string) {
		if name != "" {
			affected[name] = true
		}
	}

	for _, it := range cr.Items {
		if it.Scope == "global" {
			global = true
			param, ok := p.ParamByID(it.ParamID)
			if !ok {
				continue
			}
			for _, inst := range p.Registry.Instances {
				// The shared edit changes an instance's effective value only when
				// that instance does not override the parameter itself.
				if rv.Resolve(param, inst).Layer != model.LayerInstance {
					mark(inst.Name)
				}
			}
			continue
		}
		mark(it.Instance)
	}

	instances := make([]string, 0, len(affected))
	for name := range affected {
		instances = append(instances, name)
	}
	sort.Strings(instances)

	envSet := map[string]bool{}
	touchesProd := false
	for _, name := range instances {
		inst, ok := p.InstanceByName(name)
		if !ok || inst.Environment == "" {
			continue
		}
		envSet[inst.Environment] = true
		if isProductionEnv(inst.Environment) {
			touchesProd = true
		}
	}
	envs := make([]string, 0, len(envSet))
	for e := range envSet {
		envs = append(envs, e)
	}
	sort.Strings(envs)

	return Impact{
		Instances:         instances,
		InstanceCount:     len(instances),
		Environments:      envs,
		TouchesProduction: touchesProd,
		Global:            global,
	}
}

// isProductionEnv reports whether an environment label denotes production, so a
// change touching it can be weighted more heavily at approval time.
func isProductionEnv(env string) bool {
	switch strings.ToLower(strings.TrimSpace(env)) {
	case "production", "prod":
		return true
	}
	return false
}
