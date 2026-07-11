// Package diff computes semantic, parameter-level differences between two
// instances (or two value sets). This is the basis for the Compare view and
// for parameter-level 3-way merge during change requests.
package diff

import (
	"fmt"
	"sort"

	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/resolver"
)

// Status classifies a parameter's difference between two sides.
type Status string

const (
	Added     Status = "added"
	Removed   Status = "removed"
	Modified  Status = "modified"
	Unchanged Status = "unchanged"
)

// Change is a single parameter's difference.
type Change struct {
	ParamID string `json:"paramId"`
	Name    string `json:"name"`
	Left    any    `json:"left"`
	Right   any    `json:"right"`
	Status  Status `json:"status"`
}

// Summary aggregates change counts, mirroring the mockup's summary panel.
type Summary struct {
	Added     int `json:"added"`
	Removed   int `json:"removed"`
	Modified  int `json:"modified"`
	Unchanged int `json:"unchanged"`
	Total     int `json:"total"`
}

// Result bundles the changes and their summary.
type Result struct {
	Left    string   `json:"left"`
	Right   string   `json:"right"`
	Changes []Change `json:"changes"`
	Summary Summary  `json:"summary"`
}

// CompareInstances diffs the effective values of two instances in a project.
func CompareInstances(p *project.Project, leftName, rightName string) (Result, error) {
	return CompareAcross(p, leftName, p, rightName)
}

// resolvedValue is one parameter's effective value on one side.
type resolvedValue struct {
	name  string
	value any
	set   bool
}

// snapshot resolves every parameter for one instance in one project, keyed by
// parameter ID, so two snapshots (possibly from different git refs, so with
// different catalogs) can be compared by identity.
func snapshot(p *project.Project, instanceName string) (map[string]resolvedValue, error) {
	inst, ok := p.InstanceByName(instanceName)
	if !ok {
		return nil, fmt.Errorf("instance %q not found", instanceName)
	}
	r := &resolver.Resolver{Scopes: p.Scopes, Instance: p.Overlays}
	out := make(map[string]resolvedValue, len(p.Catalog.Parameters))
	for _, param := range p.Catalog.Parameters {
		v := r.Resolve(param, inst)
		out[param.ID] = resolvedValue{name: param.Name, value: v.Value, set: v.Set}
	}
	return out, nil
}

// CompareAcross diffs the effective values of one instance in pLeft against
// another instance in pRight. The two projects may be different git refs, so a
// parameter can exist on one side only (a version added/removed it): the union
// of parameter IDs is compared by identity.
func CompareAcross(pLeft *project.Project, leftName string, pRight *project.Project, rightName string) (Result, error) {
	left, err := snapshot(pLeft, leftName)
	if err != nil {
		return Result{}, err
	}
	right, err := snapshot(pRight, rightName)
	if err != nil {
		return Result{}, err
	}

	ids := make([]string, 0, len(left))
	seen := map[string]bool{}
	for id := range left {
		ids = append(ids, id)
		seen[id] = true
	}
	for id := range right {
		if !seen[id] {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)

	res := Result{Left: leftName, Right: rightName}
	for _, id := range ids {
		lv := left[id]
		rv := right[id]
		name := lv.name
		if name == "" {
			name = rv.name
		}
		ch := Change{ParamID: id, Name: name, Left: lv.value, Right: rv.value}
		switch {
		case !lv.set && !rv.set:
			continue
		case !lv.set && rv.set:
			ch.Status = Added
			res.Summary.Added++
		case lv.set && !rv.set:
			ch.Status = Removed
			res.Summary.Removed++
		case fmt.Sprintf("%v", lv.value) != fmt.Sprintf("%v", rv.value):
			ch.Status = Modified
			res.Summary.Modified++
		default:
			ch.Status = Unchanged
			res.Summary.Unchanged++
		}
		res.Summary.Total++
		res.Changes = append(res.Changes, ch)
	}
	return res, nil
}
