// Package render produces the generated/ artifacts for an instance: the base
// source files with resolved values applied, plus any Transposer plugin
// outputs (e.g. synthesized Flux manifests). Rendering is deterministic so
// re-renders never create spurious diffs.
package render

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/resolver"
	"gopkg.in/yaml.v3"
)

// OutputFile is a rendered artifact (path relative to generated/<instance>/).
type OutputFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// Instance renders all generated artifacts for one instance.
func Instance(p *project.Project, instanceName string, reg *plugin.Registry) ([]OutputFile, error) {
	inst, ok := p.InstanceByName(instanceName)
	if !ok {
		return nil, fmt.Errorf("instance %q not found", instanceName)
	}
	r := &resolver.Resolver{Scopes: p.Scopes, Instance: p.Overlays}

	// Resolve every parameter for this instance, and group by source YAML file.
	resolved := map[string]any{}                 // paramID -> value
	params := map[string]model.Parameter{}       // paramID -> param
	byFile := map[string]map[string]any{}        // yaml file -> dot-path -> value
	for _, param := range p.Catalog.Parameters {
		res := r.Resolve(param, inst)
		if !res.Set {
			continue
		}
		resolved[param.ID] = res.Value
		params[param.ID] = param
		if param.Source.Format == "yaml" {
			m, ok := byFile[param.Source.File]
			if !ok {
				m = map[string]any{}
				byFile[param.Source.File] = m
			}
			m[strings.TrimPrefix(param.Source.Path, "$.")] = res.Value
		}
	}

	var out []OutputFile

	// Render each YAML source file as a flat value document at generated/<inst>/<file>.
	files := make([]string, 0, len(byFile))
	for f := range byFile {
		files = append(files, f)
	}
	sort.Strings(files)
	for _, f := range files {
		nested := unflatten(byFile[f])
		b, err := yaml.Marshal(nested)
		if err != nil {
			return nil, err
		}
		out = append(out, OutputFile{Path: filepath.Base(f), Content: string(b)})
	}

	// Delegate to transposer plugins (e.g. Flux artifact generation).
	for _, t := range reg.Transposers() {
		gen, err := t.Generate(plugin.GenContext{Instance: inst, Values: resolved, Params: params})
		if err != nil {
			return nil, fmt.Errorf("transposer %s: %w", t.Manifest().ID, err)
		}
		for _, o := range gen {
			out = append(out, OutputFile{Path: o.Path, Content: string(o.Content)})
		}
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// unflatten turns dot-delimited paths into a nested map for YAML output.
func unflatten(flat map[string]any) map[string]any {
	root := map[string]any{}
	for path, val := range flat {
		segs := strings.Split(path, ".")
		cur := root
		for i, seg := range segs {
			if i == len(segs)-1 {
				cur[seg] = val
				break
			}
			next, ok := cur[seg].(map[string]any)
			if !ok {
				next = map[string]any{}
				cur[seg] = next
			}
			cur = next
		}
	}
	return root
}
