// Package diff computes semantic, parameter-level differences between two
// instances (or two value sets). This is the basis for the Compare view and
// for parameter-level 3-way merge during change requests.
package diff

import (
	"fmt"

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
	left, ok := p.InstanceByName(leftName)
	if !ok {
		return Result{}, fmt.Errorf("instance %q not found", leftName)
	}
	right, ok := p.InstanceByName(rightName)
	if !ok {
		return Result{}, fmt.Errorf("instance %q not found", rightName)
	}

	r := &resolver.Resolver{Scopes: p.Scopes, Instance: p.Overlays}
	res := Result{Left: leftName, Right: rightName}

	for _, param := range p.Catalog.Parameters {
		lv := r.Resolve(param, left)
		rv := r.Resolve(param, right)

		ch := Change{ParamID: param.ID, Name: param.Name, Left: lv.Value, Right: rv.Value}
		switch {
		case !lv.Set && !rv.Set:
			continue
		case !lv.Set && rv.Set:
			ch.Status = Added
			res.Summary.Added++
		case lv.Set && !rv.Set:
			ch.Status = Removed
			res.Summary.Removed++
		case fmt.Sprintf("%v", lv.Value) != fmt.Sprintf("%v", rv.Value):
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
