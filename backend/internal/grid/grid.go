// Package grid assembles the parameter x instance matrix that powers the
// spreadsheet UI: effective values, the scope that supplied each value,
// per-cell lifecycle state (deprecated / new / not-applicable), and validation.
package grid

import (
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/resolver"
	"github.com/abhijeet-oxide/configer/backend/internal/semver"
	"github.com/abhijeet-oxide/configer/backend/internal/validate"
)

// CellState describes the lifecycle status of a cell for a given instance
// software version.
type CellState string

const (
	StateNormal        CellState = "normal"
	StateNew           CellState = "new"           // introduced at this instance's version
	StateDeprecated    CellState = "deprecated"    // deprecated at/before this version
	StateNotApplicable CellState = "na"            // not yet introduced at this version
)

// Cell is one parameter's value for one instance.
type Cell struct {
	Value    any         `json:"value"`
	Source   model.Scope `json:"source"`         // scope that supplied the value
	Set      bool        `json:"set"`            // whether any scope set a value
	State    CellState   `json:"state"`
	Valid    bool        `json:"valid"`
	Message  string      `json:"message,omitempty"`
	Editable bool        `json:"editable"`
	// Pending marks a value staged in the current draft change request but
	// not yet committed to Git.
	Pending bool `json:"pending,omitempty"`
	// Excluded marks an instance-level tombstone: nothing renders for this
	// cell in generated files, even when a default exists.
	Excluded bool `json:"excluded,omitempty"`
}

// Row is a parameter and its cells across all instances (indexed by instance
// name).
type Row struct {
	Param model.Parameter `json:"param"`
	Cells map[string]Cell `json:"cells"`
}

// Grid is the full matrix plus the instance (column) list and the category
// tree used by the left panel.
type Grid struct {
	Project    string           `json:"project"`
	Instances  []model.Instance `json:"instances"`
	Rows       []Row            `json:"rows"`
	Categories []CategoryNode   `json:"categories"`
}

// CategoryNode is a node in the parameter category tree (left panel).
type CategoryNode struct {
	Key      string         `json:"key"`
	Title    string         `json:"title"`
	Count    int            `json:"count"`
	Children []CategoryNode `json:"children,omitempty"`
}

// Build assembles the grid from a loaded project.
func Build(p *project.Project) Grid {
	r := &resolver.Resolver{Scopes: p.Scopes, Instance: p.Overlays}

	// Archived instances are kept in the registry (and shown in the Instances
	// view) but drop out of the active grid so archiving declutters editing.
	active := make([]model.Instance, 0, len(p.Registry.Instances))
	for _, inst := range p.Registry.Instances {
		if inst.Status != "archived" {
			active = append(active, inst)
		}
	}

	g := Grid{
		Project:   p.Catalog.Metadata.Project,
		Instances: active,
	}

	for _, param := range p.Catalog.Parameters {
		if isIgnored(param, p.Ignore) {
			continue
		}
		row := Row{Param: param, Cells: make(map[string]Cell, len(active))}
		for _, inst := range active {
			state := cellState(param, inst)
			res := r.Resolve(param, inst)
			cell := Cell{
				Value:    res.Value,
				Source:   res.Source,
				Set:      res.Set,
				Excluded: res.Excluded,
				State:    state,
				Editable: state != StateNotApplicable && state != StateDeprecated,
			}
			if state == StateNotApplicable {
				cell.Valid = true
			} else {
				vr := validate.Value(param, res.Value)
				cell.Valid = vr.Valid
				cell.Message = vr.Message
			}
			row.Cells[inst.Name] = cell
		}
		g.Rows = append(g.Rows, row)
	}

	g.Categories = buildCategoryTree(g.Rows)
	return g
}

// cellState derives the lifecycle state from parameter version metadata and the
// instance's software version.
func cellState(param model.Parameter, inst model.Instance) CellState {
	iv := inst.SoftwareVersion
	if iv == "" {
		return StateNormal
	}
	if param.VersionDeprecated != "" && semver.Compare(iv, param.VersionDeprecated) >= 0 {
		return StateDeprecated
	}
	if param.VersionIntroduced != "" {
		switch semver.Compare(iv, param.VersionIntroduced) {
		case -1:
			return StateNotApplicable
		case 0:
			return StateNew
		}
	}
	return StateNormal
}

func isIgnored(param model.Parameter, ig project.Ignore) bool {
	for _, id := range ig.Parameters {
		if id == param.ID || id == param.Source.Path {
			return true
		}
	}
	return false
}

// buildCategoryTree groups parameters by their "/"-delimited category path and
// counts parameters per node.
func buildCategoryTree(rows []Row) []CategoryNode {
	type node struct {
		title    string
		count    int
		children map[string]*node
		order    []string
	}
	root := &node{children: map[string]*node{}}
	add := func(segs []string) {
		cur := root
		for _, seg := range segs {
			child, ok := cur.children[seg]
			if !ok {
				child = &node{title: seg, children: map[string]*node{}}
				cur.children[seg] = child
				cur.order = append(cur.order, seg)
			}
			child.count++
			cur = child
		}
	}
	for _, r := range rows {
		cat := r.Param.Category
		if cat == "" {
			cat = "Uncategorized"
		}
		add(strings.Split(cat, "/"))
	}

	var conv func(prefix string, n *node) []CategoryNode
	conv = func(prefix string, n *node) []CategoryNode {
		keys := make([]string, len(n.order))
		copy(keys, n.order)
		sort.Strings(keys)
		out := make([]CategoryNode, 0, len(keys))
		for _, k := range keys {
			c := n.children[k]
			key := prefix + "/" + k
			out = append(out, CategoryNode{
				Key:      strings.TrimPrefix(key, "/"),
				Title:    c.title,
				Count:    c.count,
				Children: conv(key, c),
			})
		}
		return out
	}
	return conv("", root)
}
