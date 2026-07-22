// Package resolver computes the effective value of a parameter for a given
// instance by reading the repository's own files through the parameter's
// bindings, in layer precedence order (default < base < instance). It reports
// the value, the layer, and the file that supplied it, so the UI can show a
// "source" badge on each cell and jump to the exact location.
package resolver

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/pathedit"
)

// Resolved is the outcome of resolving one (parameter, instance) cell.
type Resolved struct {
	Value any    // effective value, or nil when no layer supplies one
	Layer string // model.LayerDefault | LayerBase | LayerInstance
	File  string // repository file that supplied the value ("" for default)
	Path  string // path within File ("" for default)
	Set   bool   // whether any layer (including the default) supplied a value
}

// Resolver reads values from a repository working tree. It caches each file's
// PARSED document, so one Resolver instance is cheap to use across a whole grid
// build (every cell resolves the same handful of files, and each is parsed only
// once). Create a fresh Resolver per request to observe new commits.
type Resolver struct {
	Root string
	// Catalog, when set, enables derived defaults: a parameter whose Derived
	// expression references another parameter resolves to that parameter's
	// effective value (for the same instance). Leave nil to disable derivation
	// (identical to the original behavior).
	Catalog []model.Parameter
	docs    map[string]*pathedit.Document // keyed by repo-relative file path
}

// New returns a Resolver reading from the working tree rooted at root.
func New(root string) *Resolver {
	return &Resolver{Root: root, docs: map[string]*pathedit.Document{}}
}

// NewWithCatalog returns a Resolver that can evaluate derived defaults against
// the given parameter catalog.
func NewWithCatalog(root string, catalog []model.Parameter) *Resolver {
	return &Resolver{Root: root, Catalog: catalog, docs: map[string]*pathedit.Document{}}
}

// Param looks up a catalog parameter by id. Used to resolve cross-parameter
// relations (e.g. a resource limit reading its request's effective value).
func (r *Resolver) Param(id string) (model.Parameter, bool) {
	for _, p := range r.Catalog {
		if p.ID == id {
			return p, true
		}
	}
	return model.Parameter{}, false
}

// doc returns the parsed document for a file, parsing (and caching) it on first
// use. A missing or malformed file caches a nil document, so every lookup in it
// cleanly misses without re-reading from disk.
func (r *Resolver) doc(file, format string) *pathedit.Document {
	if d, ok := r.docs[file]; ok {
		return d
	}
	var d *pathedit.Document
	if b, err := os.ReadFile(filepath.Join(r.Root, file)); err == nil {
		d, _ = pathedit.Parse(b, format) // parse error -> nil doc (treated as empty)
	}
	r.docs[file] = d
	return d
}

// Resolve returns the effective value of param for the given instance: the
// parameter's declared default (or, when set and enabled, its derived default),
// overridden by a base-layer file value, overridden by an instance-layer file
// value.
func (r *Resolver) Resolve(param model.Parameter, inst model.Instance) Resolved {
	return r.resolve(param, inst, nil)
}

// resolve is Resolve with a cycle guard threaded through derived-value lookups
// (visiting holds the parameter ids currently being derived).
func (r *Resolver) resolve(param model.Parameter, inst model.Instance, visiting map[string]bool) Resolved {
	res := Resolved{}
	if param.Default != nil {
		res = Resolved{Value: param.Default, Layer: model.LayerDefault, Set: true}
	}
	// A derived default (when catalogs are wired in) computes a value from
	// another parameter; it overrides the static default but any real file
	// value below still wins, keeping the write-back model intact.
	if r.Catalog != nil && strings.TrimSpace(param.Derived) != "" {
		if v, ok := r.derive(param, inst, visiting); ok {
			res = Resolved{Value: v, Layer: model.LayerDerived, Set: true}
		}
	}
	for _, layer := range model.LayerOrder {
		for _, b := range param.BindingsOn(layer, inst) {
			d := r.doc(b.File, b.Format)
			v, ok, err := d.Get(b.Path)
			if err != nil || !ok {
				continue
			}
			res = Resolved{Value: v, Layer: layer, File: b.File, Path: b.Path, Set: true}
			break // first resolving binding wins the layer
		}
	}
	return res
}

// derivedRe matches a derived expression: "{param-id}" with an optional integer
// offset, e.g. "{net-admin-port}", "{base-port}+1", "{base-port}-2".
var derivedRe = regexp.MustCompile(`^\{([a-zA-Z0-9_.-]+)\}\s*([+-]\s*\d+)?$`)

// derive evaluates a parameter's Derived expression for one instance: it looks
// up the referenced parameter's effective value and applies an optional integer
// offset. It returns (value, true) on success, or (nil, false) when the
// expression is malformed, the reference is unknown or unresolved, or a cycle is
// detected.
func (r *Resolver) derive(param model.Parameter, inst model.Instance, visiting map[string]bool) (any, bool) {
	m := derivedRe.FindStringSubmatch(strings.TrimSpace(param.Derived))
	if m == nil {
		return nil, false
	}
	refID := m[1]
	if visiting[param.ID] || refID == param.ID {
		return nil, false // self-reference / cycle
	}
	var ref *model.Parameter
	for i := range r.Catalog {
		if r.Catalog[i].ID == refID {
			ref = &r.Catalog[i]
			break
		}
	}
	if ref == nil {
		return nil, false
	}
	next := map[string]bool{param.ID: true}
	for k := range visiting {
		next[k] = true
	}
	refRes := r.resolve(*ref, inst, next)
	if !refRes.Set {
		return nil, false
	}
	if m[2] == "" {
		return refRes.Value, true
	}
	offset, err := strconv.Atoi(strings.ReplaceAll(m[2], " ", ""))
	if err != nil {
		return refRes.Value, true
	}
	base, ok := toInt(refRes.Value)
	if !ok {
		return refRes.Value, true // non-integer base: offset does not apply
	}
	return base + offset, true
}

// toInt coerces the common numeric shapes a resolved value can take (from YAML
// parsing or JSON round-trips) to an int.
func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	case string:
		if i, err := strconv.Atoi(strings.TrimSpace(n)); err == nil {
			return i, true
		}
	}
	return 0, false
}
