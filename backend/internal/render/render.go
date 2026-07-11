// Package render produces the generated/ artifacts for an instance.
//
// The base file is the template; managed parameters are applied onto it with
// explicit presence semantics:
//
//   - a parameter with a resolved value is WRITTEN at its path;
//   - an unset or excluded parameter is REMOVED entirely: no key, no line,
//     no element appears in that instance's file;
//   - a list parameter renders its collection natively: a YAML/JSON array, or
//     repeated sibling elements in XML, so one instance can carry 1 entry
//     and another 10;
//   - unmanaged content in the base file passes through untouched.
//
// Rendering is deterministic (sorted application order) so re-renders never
// produce spurious diffs. Transposer plugins run after file rendering and can
// synthesize additional artifacts (e.g. Flux manifests).
package render

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/resolver"
	"github.com/beevik/etree"
	"gopkg.in/yaml.v3"
)

// OutputFile is a rendered artifact (path relative to generated/<instance>/).
type OutputFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// application is one parameter's effect on a file: write Value at Path, or
// remove Path entirely.
type application struct {
	param  model.Parameter
	value  any
	remove bool
}

// Instance renders all generated artifacts for one instance.
func Instance(p *project.Project, instanceName string, reg *plugin.Registry) ([]OutputFile, error) {
	inst, ok := p.InstanceByName(instanceName)
	if !ok {
		return nil, fmt.Errorf("instance %q not found", instanceName)
	}
	r := &resolver.Resolver{Scopes: p.Scopes, Instance: p.Overlays}

	resolved := map[string]any{}           // paramID -> effective value (transposers)
	params := map[string]model.Parameter{} // paramID -> param
	byFile := map[string][]application{}   // source file -> applications

	for _, param := range p.Catalog.Parameters {
		if param.Source.File == "" {
			// Design-phase parameter: not attached to any file yet, so it
			// appears in NO generated artifact (source files or transposer
			// outputs) until attached.
			continue
		}
		res := r.Resolve(param, inst)
		app := application{param: param}
		switch {
		case res.Excluded, !res.Set:
			app.remove = true // absence: strip the key/element from the template
		default:
			app.value = res.Value
			resolved[param.ID] = res.Value
			params[param.ID] = param
		}
		byFile[param.Source.File] = append(byFile[param.Source.File], app)
	}

	var out []OutputFile
	files := make([]string, 0, len(byFile))
	for f := range byFile {
		files = append(files, f)
	}
	sort.Strings(files)

	for _, f := range files {
		apps := byFile[f]
		// Deterministic application order.
		sort.Slice(apps, func(i, j int) bool { return apps[i].param.Source.Path < apps[j].param.Source.Path })

		format := ""
		for _, a := range apps {
			if a.param.Source.Format != "" {
				format = a.param.Source.Format
				break
			}
		}
		base, _ := os.ReadFile(filepath.Join(p.Root, f)) // missing base => start empty

		var content string
		var err error
		switch format {
		case "xml":
			content, err = renderXML(base, apps)
		case "json":
			content, err = renderTree(base, apps, "json")
		default:
			content, err = renderTree(base, apps, "yaml")
		}
		if err != nil {
			return nil, fmt.Errorf("render %s: %w", f, err)
		}
		out = append(out, OutputFile{Path: outputPath(f), Content: content})
	}

	// Transposer plugins (e.g. Flux generator) see only present values, so
	// excluded parameters vanish from synthesized artifacts too.
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

	// Dedupe by output path so a file never appears twice (two source files can
	// map to the same generated path, e.g. base/x.xml and x.xml). Deterministic:
	// the first entry for a path wins after sorting.
	if len(out) > 1 {
		seen := make(map[string]bool, len(out))
		uniq := out[:0]
		for _, o := range out {
			if seen[o.Path] {
				continue
			}
			seen[o.Path] = true
			uniq = append(uniq, o)
		}
		out = uniq
	}
	return out, nil
}

// outputPath maps a source file to its generated/<instance>/ relative path.
func outputPath(src string) string {
	return strings.TrimPrefix(filepath.ToSlash(src), "base/")
}

// --- YAML / JSON -----------------------------------------------------------

// renderTree loads the base document (YAML or JSON), applies managed
// parameters (set or delete at dotted path), and re-serializes.
func renderTree(base []byte, apps []application, format string) (string, error) {
	root := map[string]any{}
	if len(base) > 0 {
		var doc any
		var err error
		if format == "json" {
			err = json.Unmarshal(base, &doc)
		} else {
			err = yaml.Unmarshal(base, &doc)
		}
		if err != nil {
			return "", err
		}
		if m, ok := normalize(doc).(map[string]any); ok {
			root = m
		}
	}

	for _, a := range apps {
		segs := pathSegments(a.param.Source.Path)
		if len(segs) == 0 {
			continue
		}
		if a.remove {
			deleteAt(root, segs)
		} else {
			setAt(root, segs, a.value)
		}
	}

	if format == "json" {
		b, err := json.MarshalIndent(root, "", "  ")
		return string(b) + "\n", err
	}
	b, err := yaml.Marshal(root)
	return string(b), err
}

// pathSegments turns "$.a.b.c" into ["a","b","c"] (array indices unsupported
// for tree paths; model collections as list parameters instead).
func pathSegments(path string) []string {
	s := strings.TrimPrefix(path, "$.")
	s = strings.TrimPrefix(s, "$")
	if s == "" {
		return nil
	}
	return strings.Split(s, ".")
}

func setAt(root map[string]any, segs []string, val any) {
	cur := root
	for i, seg := range segs {
		if i == len(segs)-1 {
			cur[seg] = val
			return
		}
		next, ok := cur[seg].(map[string]any)
		if !ok {
			next = map[string]any{}
			cur[seg] = next
		}
		cur = next
	}
}

// deleteAt removes the leaf and prunes now-empty parent maps so absence is
// total (no dangling empty sections).
func deleteAt(root map[string]any, segs []string) {
	parents := make([]map[string]any, 0, len(segs))
	cur := root
	for i, seg := range segs {
		if i == len(segs)-1 {
			delete(cur, seg)
			break
		}
		next, ok := cur[seg].(map[string]any)
		if !ok {
			return // path not present: nothing to remove
		}
		parents = append(parents, cur)
		cur = next
	}
	// prune empty parents bottom-up
	for i := len(parents) - 1; i >= 0; i-- {
		child, _ := parents[i][segs[i]].(map[string]any)
		if child != nil && len(child) == 0 {
			delete(parents[i], segs[i])
		}
	}
}

// normalize converts map[any]any into map[string]any recursively.
func normalize(v any) any {
	switch n := v.(type) {
	case map[any]any:
		m := make(map[string]any, len(n))
		for k, val := range n {
			m[fmt.Sprintf("%v", k)] = normalize(val)
		}
		return m
	case map[string]any:
		for k, val := range n {
			n[k] = normalize(val)
		}
		return n
	case []any:
		for i := range n {
			n[i] = normalize(n[i])
		}
		return n
	default:
		return v
	}
}

// --- XML ---------------------------------------------------------------

// renderXML loads the base XML template and applies managed parameters:
// attributes and element text are set or removed; list parameters replace the
// repeated sibling elements at their path (one element per entry, so
// cardinality follows the instance's list length).
func renderXML(base []byte, apps []application) (string, error) {
	doc := etree.NewDocument()
	if len(base) > 0 {
		if err := doc.ReadFromBytes(base); err != nil {
			return "", err
		}
	}

	for _, a := range apps {
		path := a.param.Source.Path
		if a.param.Type == model.TypeList {
			applyXMLList(doc, path, a)
			continue
		}
		if attr, elemPath, isAttr := splitAttrPath(path); isAttr {
			el := findXML(doc, elemPath)
			if a.remove {
				if el != nil {
					el.RemoveAttr(attr)
				}
				continue
			}
			if el == nil {
				el = ensureXML(doc, elemPath)
			}
			el.CreateAttr(attr, scalarString(a.value))
			continue
		}
		el := findXML(doc, path)
		if a.remove {
			if el != nil && el.Parent() != nil {
				parent := el.Parent()
				parent.RemoveChild(el)
				pruneEmptyXML(parent)
			}
			continue
		}
		if el == nil {
			el = ensureXML(doc, path)
		}
		el.SetText(scalarString(a.value))
	}

	doc.Indent(2)
	s, err := doc.WriteToString()
	return s, err
}

// applyXMLList replaces every <tag> child at the path's parent with one
// element per list entry (or removes them all when the parameter is absent).
func applyXMLList(doc *etree.Document, path string, a application) {
	segs := xmlSegments(path)
	if len(segs) == 0 {
		return
	}
	tag := segs[len(segs)-1]
	parentPath := "/" + strings.Join(segs[:len(segs)-1], "/")

	parent := findXML(doc, parentPath)
	if parent == nil {
		if a.remove {
			return
		}
		parent = ensureXML(doc, parentPath)
	}
	for _, child := range parent.SelectElements(tag) {
		parent.RemoveChild(child)
	}
	if a.remove {
		pruneEmptyXML(parent)
		return
	}
	items, _ := a.value.([]any)
	for _, it := range items {
		parent.CreateElement(tag).SetText(scalarString(it))
	}
	if len(items) == 0 {
		pruneEmptyXML(parent)
	}
}

// pruneEmptyXML removes now-empty elements bottom-up (never the root), so
// absence leaves no husk like <syslog/> behind.
func pruneEmptyXML(el *etree.Element) {
	for el != nil {
		parent := el.Parent()
		// parent == nil: detached; parent.Parent() == nil: el is the root
// element (its parent is the document container); keep the root.
		if parent == nil || parent.Parent() == nil {
			return
		}
		if len(el.ChildElements()) > 0 || len(el.Attr) > 0 || strings.TrimSpace(el.Text()) != "" {
			return
		}
		parent.RemoveChild(el)
		el = parent
	}
}

func splitAttrPath(path string) (attr, elemPath string, isAttr bool) {
	i := strings.LastIndex(path, "/@")
	if i < 0 {
		return "", "", false
	}
	return path[i+2:], path[:i], true
}

func xmlSegments(path string) []string {
	path = strings.Trim(path, "/")
	if path == "" {
		return nil
	}
	return strings.Split(path, "/")
}

// findXML locates an element, tolerating [n] index predicates from ingest.
func findXML(doc *etree.Document, path string) *etree.Element {
	if el := doc.FindElement(path); el != nil {
		return el
	}
	// strip predicates and walk first-matches
	var cur *etree.Element
	for i, seg := range xmlSegments(path) {
		tag := seg
		if j := strings.Index(tag, "["); j >= 0 {
			tag = tag[:j]
		}
		if i == 0 {
			root := doc.Root()
			if root == nil || root.Tag != tag {
				return nil
			}
			cur = root
			continue
		}
		cur = cur.SelectElement(tag)
		if cur == nil {
			return nil
		}
	}
	return cur
}

// ensureXML creates the element chain for path (predicates ignored).
func ensureXML(doc *etree.Document, path string) *etree.Element {
	segs := xmlSegments(path)
	var cur *etree.Element
	for i, seg := range segs {
		tag := seg
		if j := strings.Index(tag, "["); j >= 0 {
			tag = tag[:j]
		}
		if i == 0 {
			root := doc.Root()
			if root == nil {
				root = doc.CreateElement(tag)
			}
			cur = root
			continue
		}
		next := cur.SelectElement(tag)
		if next == nil {
			next = cur.CreateElement(tag)
		}
		cur = next
	}
	return cur
}

func scalarString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return fmt.Sprintf("%v", v)
	}
}
