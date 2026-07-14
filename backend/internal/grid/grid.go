// Package grid assembles the parameter x instance matrix that powers the
// spreadsheet UI: effective values read from the repository's own files, the
// layer and file that supplied each value, per-cell lifecycle state
// (deprecated / new / not-applicable), and validation.
package grid

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
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
	StateNew           CellState = "new"        // introduced at this instance's version
	StateDeprecated    CellState = "deprecated" // deprecated at/before this version
	StateNotApplicable CellState = "na"         // not yet introduced at this version
)

// Cell is one parameter's value for one instance.
type Cell struct {
	Value any `json:"value"`
	// Source is the layer that supplied the value: "default" (parameter
	// metadata), "base" (a shared file), or "instance" (the instance's own
	// files).
	Source string `json:"source"`
	// File/Path locate the value in the repository when it came from a file.
	File     string    `json:"file,omitempty"`
	Path     string    `json:"path,omitempty"`
	Set      bool      `json:"set"` // whether any layer supplied a value
	State    CellState `json:"state"`
	Valid    bool      `json:"valid"`
	Message  string    `json:"message,omitempty"`
	Editable bool      `json:"editable"`
	// Pending marks a value staged in the current draft change request but
	// not yet committed to Git.
	Pending bool `json:"pending,omitempty"`
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

// Build assembles the grid from a loaded project by resolving every cell from
// the repository's real files.
func Build(p *project.Project) Grid {
	r := resolver.New(p.Root)

	// Archived instances are kept in the registry (and shown in the Instances
	// view) but drop out of the active grid so archiving declutters editing.
	active := make([]model.Instance, 0, len(p.Registry.Instances))
	for _, inst := range p.Registry.Instances {
		if inst.Status != "archived" {
			active = append(active, inst)
		}
	}

	g := Grid{
		Project:   p.Name(),
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
				Source:   res.Layer,
				File:     res.File,
				Path:     res.Path,
				Set:      res.Set,
				State:    state,
				Editable: state != StateNotApplicable && state != StateDeprecated,
			}
			if state == StateNotApplicable || !res.Set {
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

// ApplyDraft previews pending draft items on top of a built grid, so the UI
// shows exactly what submitting would write. A "set" item shows the staged
// value; "reset" and "exclude" show the cell going absent. A global item
// previews on every cell not already supplied by the instance layer. A staged
// add-instance appears as a new "draft" column (cells copied from its clone
// source, all pending); a staged remove-instance marks the column "retiring".
func ApplyDraft(g *Grid, items []change.Item) {
	if len(items) == 0 {
		return
	}
	type key struct{ param, inst string }
	instItems := map[key]change.Item{}
	globalItems := map[string]change.Item{}
	for _, it := range items {
		if it.Structural() {
			applyStructuralPreview(g, it)
			continue
		}
		if it.Scope == "global" {
			globalItems[it.ParamID] = it
			continue
		}
		instItems[key{it.ParamID, it.Instance}] = it
	}

	for i := range g.Rows {
		id := g.Rows[i].Param.ID
		for name, c := range g.Rows[i].Cells {
			if it, ok := instItems[key{id, name}]; ok {
				c.Pending = true
				if it.Act() == change.ActionSet {
					c.Value, c.Set, c.Source = it.New, true, model.LayerInstance
				} else {
					c.Value, c.Set = nil, false
				}
			}
			if it, ok := globalItems[id]; ok && c.Source != model.LayerInstance {
				c.Pending = true
				if it.Act() == change.ActionSet {
					c.Value, c.Set, c.Source = it.New, true, model.LayerBase
				} else {
					c.Value, c.Set = nil, false
				}
			}
			g.Rows[i].Cells[name] = c
		}
	}
}

// applyStructuralPreview mirrors a staged topology change onto the grid.
func applyStructuralPreview(g *Grid, it change.Item) {
	switch it.Act() {
	case change.ActionAddInstance:
		for _, inst := range g.Instances {
			if inst.Name == it.Instance {
				return // already previewed
			}
		}
		var meta model.Instance
		if b, err := json.Marshal(it.New); err == nil {
			_ = json.Unmarshal(b, &meta)
		}
		meta.Name = it.Instance
		meta.Status = "draft" // pending: not on Git until the CR publishes
		g.Instances = append(g.Instances, meta)
		cloneFrom, _ := it.Old.(string)
		for i := range g.Rows {
			cell := Cell{State: StateNormal, Valid: true, Pending: true}
			if src, ok := g.Rows[i].Cells[cloneFrom]; ok && cloneFrom != "" {
				cell.Value, cell.Set, cell.Source = src.Value, src.Set, src.Source
			}
			g.Rows[i].Cells[it.Instance] = cell
		}
	case change.ActionRemoveInstance:
		for i := range g.Instances {
			if g.Instances[i].Name == it.Instance {
				g.Instances[i].Status = "retiring" // pending removal
			}
		}
	}
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
		if id == param.ID {
			return true
		}
		for _, b := range param.Bindings {
			if id == b.Path {
				return true
			}
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
