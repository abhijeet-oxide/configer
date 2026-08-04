// Package grid assembles the parameter x instance matrix that powers the
// spreadsheet UI: effective values read from the repository's own files, the
// layer and file that supplied each value, per-cell lifecycle state
// (deprecated / new / not-applicable), and validation.
package grid

import (
	"encoding/json"
	"path"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/pathedit"
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
	// Templated marks a cell whose committed value is a template EXPRESSION
	// (Helm "{{ ... }}", a "${...}" reference), not a literal. Editing it as a
	// plain value would overwrite the template and break rendering, so the cell
	// is not editable in the grid; it stays visible and can be changed in file
	// mode where the expression is explicit.
	Templated bool `json:"templated,omitempty"`
	// Pending marks a value staged in the current draft change request but
	// not yet committed to Git.
	Pending bool `json:"pending,omitempty"`
}

// Row is a parameter and its cells across all instances (indexed by instance
// name).
type Row struct {
	Param model.Parameter `json:"param"`
	Cells map[string]Cell `json:"cells"`
	// PendingUnmanage marks a parameter a draft change stops managing: it is
	// still here, still editable, and will leave the catalog when that change
	// is published.
	PendingUnmanage bool `json:"pendingUnmanage,omitempty"`
	// PendingAdd marks a parameter a draft change STARTS managing: the value is
	// already in the draft's file bytes, the catalog entry arrives when the
	// change is published. It is here so a direct file edit that introduced
	// settings shows them where settings live, rather than only as a file whose
	// diff the reader has to decode.
	PendingAdd bool `json:"pendingAdd,omitempty"`
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
func Build(p *project.Project) Grid { return BuildWith(p, nil) }

// BuildWith is Build reading through a shared document cache. The grid is the
// heaviest read in the product - it touches every bound file in the repository
// - so this is where parsing once per unchanged tree, rather than once per
// request, actually pays. Pass nil for the plain per-build behavior.
func BuildWith(p *project.Project, docs resolver.Docs) Grid {
	r := resolver.NewWithCatalog(p.Root, p.Catalog.Parameters).WithDocs(docs)

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
		param.NameSegments = nameSegments(param)
		row := Row{Param: param, Cells: make(map[string]Cell, len(active))}
		for _, inst := range active {
			state := cellState(param, inst)
			res := r.Resolve(param, inst)
			templated := model.IsTemplateExpression(res.Value)
			cell := Cell{
				Value:     res.Value,
				Source:    res.Layer,
				File:      res.File,
				Path:      res.Path,
				Set:       res.Set,
				State:     state,
				Templated: templated,
				Editable:  state != StateNotApplicable && state != StateDeprecated && !templated,
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
func ApplyDraft(g *Grid, items []change.Item) { ApplyDraftWith(g, items, nil) }

// ApplyDraftWith is ApplyDraft with a resolver, which matters for one case: an
// instance that ADOPTS a folder the repository already has. Its values are not
// copied from anywhere - they are already on disk, put there by whoever
// created the folder - so the pending column reads them for real instead of
// standing empty until the change is published. Seeing what a colleague
// actually configured is the whole reason for taking the folder over.
func ApplyDraftWith(g *Grid, items []change.Item, r *resolver.Resolver) {
	if len(items) == 0 {
		return
	}
	type key struct{ param, inst string }
	instItems := map[key]change.Item{}
	globalItems := map[string]change.Item{}
	for _, it := range items {
		if it.Structural() {
			applyStructuralPreview(g, it, r)
			continue
		}
		if it.Scope == "global" {
			globalItems[it.ParamID] = it
			continue
		}
		instItems[key{it.ParamID, it.Instance}] = it
	}

	for i := range g.Rows {
		param := g.Rows[i].Param
		id := param.ID
		for name, c := range g.Rows[i].Cells {
			touched := false
			if it, ok := instItems[key{id, name}]; ok {
				c.Pending, touched = true, true
				if it.Act() == change.ActionSet {
					c.Value, c.Set, c.Source = it.New, true, model.LayerInstance
				} else {
					c.Value, c.Set = nil, false
				}
			}
			if it, ok := globalItems[id]; ok && c.Source != model.LayerInstance {
				c.Pending, touched = true, true
				if it.Act() == change.ActionSet {
					c.Value, c.Set, c.Source = it.New, true, model.LayerBase
				} else {
					c.Value, c.Set = nil, false
				}
			}
			// Re-validate against the previewed value. Without this the cell would
			// display the staged value while Valid/Message still reflect the
			// pre-draft value, so a valid edit could show as invalid (and vice
			// versa). Mirrors the validity rule in Build.
			if touched {
				if c.State == StateNotApplicable || !c.Set {
					c.Valid, c.Message = true, ""
				} else {
					vr := validate.Value(param, c.Value)
					c.Valid, c.Message = vr.Valid, vr.Message
				}
			}
			g.Rows[i].Cells[name] = c
		}
	}
}

// applyStructuralPreview mirrors a staged topology change onto the grid.
func applyStructuralPreview(g *Grid, it change.Item, r *resolver.Resolver) {
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
		cloneFrom, _ := it.Old.(string)
		// Give the pending column the folder a submit will actually scaffold, so
		// the grid (and the Files explorer, which expands {folder} bindings from
		// it) points at the real staged paths. A clone lands beside its source
		// (dir(source)/name, matching the layout adapter and the Files preview);
		// anything else falls back to instances/<name>. Without this the column
		// defaults to instances/<name> while the previewed files live beside the
		// source, so the new folder reads as unmanaged and hides from the tree.
		// An explicit folder means the instance is taking over one that is
		// already in the repository; only a scaffolded instance needs the
		// folder a submit would create.
		adopted := cloneFrom == "" && meta.Folder != "" && r != nil
		if meta.Folder == "" {
			meta.Folder = PendingInstanceFolder(g.Instances, cloneFrom, meta.Name)
		}
		g.Instances = append(g.Instances, meta)
		for i := range g.Rows {
			state := cellState(g.Rows[i].Param, meta)
			cell := Cell{State: state, Valid: true, Pending: true}
			switch {
			case adopted:
				res := r.Resolve(g.Rows[i].Param, meta)
				cell.Value, cell.Set, cell.Source = res.Value, res.Set, res.Layer
				cell.File, cell.Path = res.File, res.Path
			default:
				if src, ok := g.Rows[i].Cells[cloneFrom]; ok && cloneFrom != "" {
					cell.Value, cell.Set, cell.Source = src.Value, src.Set, src.Source
				}
			}
			// A staged instance's cells are editable like any other. Submit
			// scaffolds the folder BEFORE applying value edits (see
			// changeset.applyDraft), so adjusting a cloned value before the
			// change is published is an ordinary edit - it just lands in a
			// folder that does not exist yet.
			cell.Editable = state != StateNotApplicable && state != StateDeprecated &&
				!model.IsTemplateExpression(cell.Value)
			g.Rows[i].Cells[it.Instance] = cell
		}
	case change.ActionRemoveInstance:
		for i := range g.Instances {
			if g.Instances[i].Name == it.Instance {
				g.Instances[i].Status = "retiring" // pending removal
			}
		}
	case change.ActionAddParameter:
		for i := range g.Rows {
			if g.Rows[i].Param.ID == it.ParamID {
				return // already in the catalog (or already previewed)
			}
		}
		var pm model.Parameter
		if b, err := json.Marshal(it.New); err != nil {
			return
		} else if err := json.Unmarshal(b, &pm); err != nil || pm.ID == "" {
			return
		}
		pm.NameSegments = nameSegments(pm)
		row := Row{Param: pm, Cells: make(map[string]Cell, len(g.Instances)), PendingAdd: true}
		for _, inst := range g.Instances {
			// The value is not on disk yet - it lives in the draft's staged file
			// bytes - so the cell reads it from what the edit observed rather
			// than resolving a file that still has the old content.
			v, seen := pm.Observed[inst.Name]
			if !seen && pm.Scope == model.ScopeGlobal {
				v, seen = pm.Default, pm.Default != nil
			}
			cell := Cell{
				Value: v, Set: seen, Source: model.LayerInstance,
				State: cellState(pm, inst), Valid: true, Pending: true,
			}
			if pm.Scope == model.ScopeGlobal {
				cell.Source = model.LayerBase
			}
			if seen {
				vr := validate.Value(pm, v)
				cell.Valid, cell.Message = vr.Valid, vr.Message
			}
			// Not editable until it is really in the catalog: an edit staged
			// against a parameter that does not exist yet has nothing to write
			// through on submit.
			row.Cells[inst.Name] = cell
		}
		g.Rows = append(g.Rows, row)
	case change.ActionUnmanageParameter:
		// The row stays, marked: the parameter is still managed until the change
		// is published, and hiding it early would leave the reader wondering
		// where it went and no way to undo it from the grid.
		for i := range g.Rows {
			if g.Rows[i].Param.ID == it.ParamID {
				g.Rows[i].PendingUnmanage = true
			}
		}
	}
}

// PendingInstanceFolder mirrors the folder a submit will scaffold for a pending
// instance, so the grid column matches the files the Files preview synthesizes -
// and so the write path can resolve a parameter's bindings on an instance that
// exists only in the draft. A clone lands beside its source
// (dir(sourceFolder)/name, the layout adapter's scaffoldByCopy convention and
// api.pendingInstanceFiles); anything else (an empty instance) defaults to
// instances/<name>.
func PendingInstanceFolder(instances []model.Instance, cloneFrom, name string) string {
	if cloneFrom != "" {
		for _, inst := range instances {
			if inst.Name == cloneFrom {
				return path.Join(path.Dir(inst.FolderOrDefault()), name)
			}
		}
	}
	return "instances/" + name
}

// nameSegments spells out where a parameter's name divides, reading it back
// off the binding path the name was built from. It answers only when the
// segments RE-JOIN to exactly the name it already has: a name that came from
// somewhere else (a deduplication that kept the shortest of several names, a
// hand-written catalog entry) is not this path's to re-segment, and the client
// falls back to splitting on "." as before.
//
// Nil when the naive split is already right, which is nearly every parameter -
// a grid over a large estate carries thousands of rows and none of them should
// pay for a field that says what the name already said.
func nameSegments(p model.Parameter) []string {
	if len(p.Bindings) == 0 {
		return nil
	}
	segs := pathedit.Segments(p.Bindings[0].Format, p.Bindings[0].Path)
	if len(segs) == 0 || strings.Join(segs, ".") != p.Name {
		return nil
	}
	if len(segs) == len(strings.Split(p.Name, ".")) {
		return nil // the dot split already lands on these steps
	}
	return segs
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
