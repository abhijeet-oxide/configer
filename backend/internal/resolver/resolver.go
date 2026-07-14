// Package resolver computes the effective value of a parameter for a given
// instance by reading the repository's own files through the parameter's
// bindings, in layer precedence order (default < base < instance). It reports
// the value, the layer, and the file that supplied it, so the UI can show a
// "source" badge on each cell and jump to the exact location.
package resolver

import (
	"os"
	"path/filepath"

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

// Resolver reads values from a repository working tree. It caches file
// contents, so one Resolver instance is cheap to use across a whole grid
// build; create a fresh one per request to observe new commits.
type Resolver struct {
	Root  string
	files map[string][]byte
}

// New returns a Resolver reading from the working tree rooted at root.
func New(root string) *Resolver {
	return &Resolver{Root: root, files: map[string][]byte{}}
}

func (r *Resolver) read(file string) []byte {
	if b, ok := r.files[file]; ok {
		return b
	}
	b, err := os.ReadFile(filepath.Join(r.Root, file))
	if err != nil {
		b = nil // missing file: every lookup in it misses
	}
	r.files[file] = b
	return b
}

// Resolve returns the effective value of param for the given instance:
// the parameter's declared default, overridden by a base-layer file value,
// overridden by an instance-layer file value.
func (r *Resolver) Resolve(param model.Parameter, inst model.Instance) Resolved {
	res := Resolved{}
	if param.Default != nil {
		res = Resolved{Value: param.Default, Layer: model.LayerDefault, Set: true}
	}
	for _, layer := range model.LayerOrder {
		for _, b := range param.BindingsOn(layer, inst) {
			doc := r.read(b.File)
			if len(doc) == 0 {
				continue
			}
			v, ok, err := pathedit.Get(doc, b.Format, b.Path)
			if err != nil || !ok {
				continue
			}
			res = Resolved{Value: v, Layer: layer, File: b.File, Path: b.Path, Set: true}
			break // first resolving binding wins the layer
		}
	}
	return res
}
