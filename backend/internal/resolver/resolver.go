// Package resolver computes the effective value of a parameter for a given
// instance by applying scope precedence (default < global < environment <
// site < zone < instance). It reports both the value and the scope that
// supplied it, so the UI can show a "source" badge on each cell.
package resolver

import (
	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// Resolved is the outcome of resolving one (parameter, instance) cell.
type Resolved struct {
	Value  any         // effective value, or nil if unset at every scope
	Source model.Scope // scope that supplied Value
	Set    bool        // whether any scope (including default) supplied a value
	// Excluded means the instance explicitly omits this parameter: the
	// renderer must emit nothing for it, regardless of defaults.
	Excluded bool
}

// Resolver holds the overlay data needed to resolve values. Instance overlays
// are keyed by instance name.
type Resolver struct {
	Scopes   model.ScopeOverlays
	Instance map[string]model.Overlay // instance name -> overlay
}

// Resolve returns the effective value of param for the given instance.
func (r *Resolver) Resolve(param model.Parameter, inst model.Instance) Resolved {
	res := Resolved{}

	// An instance-level exclusion wins over every scope: nothing renders.
	if ov, ok := r.Instance[inst.Name]; ok && ov.Excludes(param.ID) {
		return Resolved{Excluded: true}
	}

	// default
	if param.Default != nil {
		res = Resolved{Value: param.Default, Source: model.ScopeDefault, Set: true}
	}
	// global
	if v, ok := r.Scopes.Global[param.ID]; ok {
		res = Resolved{Value: v, Source: model.ScopeGlobal, Set: true}
	}
	// environment
	if inst.Environment != "" {
		if m, ok := r.Scopes.Environment[inst.Environment]; ok {
			if v, ok := m[param.ID]; ok {
				res = Resolved{Value: v, Source: model.ScopeEnvironment, Set: true}
			}
		}
	}
	// site
	if inst.Site != "" {
		if m, ok := r.Scopes.Site[inst.Site]; ok {
			if v, ok := m[param.ID]; ok {
				res = Resolved{Value: v, Source: model.ScopeSite, Set: true}
			}
		}
	}
	// zone
	if inst.Zone != "" {
		if m, ok := r.Scopes.Zone[inst.Zone]; ok {
			if v, ok := m[param.ID]; ok {
				res = Resolved{Value: v, Source: model.ScopeZone, Set: true}
			}
		}
	}
	// instance (highest precedence)
	if ov, ok := r.Instance[inst.Name]; ok {
		if v, ok := ov.Values[param.ID]; ok {
			res = Resolved{Value: v, Source: model.ScopeInstance, Set: true}
		}
	}

	return res
}
