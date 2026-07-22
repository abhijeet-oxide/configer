// Package discovery turns an existing repository into a proposed Configer
// application: it detects the layout (kpt / kustomize / plain folders),
// derives the instances from the folder structure, extracts every candidate
// parameter through the ingest parsers, DEDUPLICATES the same logical setting
// across instances and files into one parameter with templated bindings, and
// attaches validation rules found in JSON Schema files. The result is a
// read-only proposal; initialization writes it to .configer/ as one commit.
package discovery

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/ingest"
	"github.com/abhijeet-oxide/configer/backend/internal/layout"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/pathedit"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// Result is the discovery proposal shown to the user before initializing.
type Result struct {
	Detection   layout.Detection  `json:"detection"`
	Instances   []model.Instance  `json:"instances"`
	Parameters  []model.Parameter `json:"parameters"`
	SharedFiles []string          `json:"sharedFiles,omitempty"`
	Skipped     []string          `json:"skipped,omitempty"`
}

// Discover scans root and builds the proposal.
func Discover(root string, reg *plugin.Registry, ignore project.Ignore) (Result, error) {
	det := layout.Detect(root)
	scan, err := ingest.Scan(root, reg, ignore)
	if err != nil {
		return Result{}, err
	}

	res := Result{Detection: det, Skipped: scan.Skipped}
	for _, li := range det.Instances {
		res.Instances = append(res.Instances, model.Instance{
			Name:        li.Name,
			Folder:      li.Folder,
			Environment: li.Environment,
			Status:      "active",
		})
	}

	// Partition scanned files: inside an instance folder (instance layer,
	// rel path within the folder) vs everything else (shared/base layer).
	folderOf := func(file string) (inst layout.Instance, rel string, ok bool) {
		for _, li := range det.Instances {
			prefix := li.Folder + "/"
			if strings.HasPrefix(file, prefix) {
				return li, strings.TrimPrefix(file, prefix), true
			}
		}
		return layout.Instance{}, "", false
	}

	type instGroup struct {
		rel        string // path within the instance folder
		path       string // path within the file
		format     string
		line       int // source line of the value (display only)
		types      map[model.ParamType]bool
		itemType   model.ParamType
		name       string
		display    string // kpt setter name when present
		byInstance map[string]any
		order      int
	}
	instGroups := map[string]*instGroup{}
	var instOrder []string

	type sharedGroup struct {
		file   string
		path   string
		format string
		line   int
		typ    model.ParamType
		item   model.ParamType
		name   string
		value  any
		order  int
	}
	sharedGroups := map[string]*sharedGroup{}
	var sharedOrder []string
	sharedSeen := map[string]bool{}

	for _, fr := range scan.Files {
		if len(fr.Candidates) == 0 || skipFile(fr.File) {
			continue
		}
		cands := foldLists(fr.Candidates)
		li, rel, inInstance := folderOf(fr.File)
		// A Kubernetes manifest (has top-level apiVersion + kind) carries
		// envelope fields that are structure, not configuration; drop them so
		// the import proposes only tunable values.
		manifest := k8sManifest(cands)

		var setters map[string]string
		if det.Layout == layout.KindKpt && inInstance {
			setters = settersFor(root, fr.File)
		}

		for _, c := range cands {
			if structuralKey(c.Path) {
				continue
			}
			if manifest && k8sStructural(c.Path) {
				continue
			}
			if inInstance {
				key := rel + "|" + c.Path
				g, ok := instGroups[key]
				if !ok {
					g = &instGroup{
						rel: rel, path: c.Path, format: c.Format, line: c.Line,
						types: map[model.ParamType]bool{}, itemType: c.itemType,
						name: c.Name, byInstance: map[string]any{}, order: len(instOrder),
					}
					instGroups[key] = g
					instOrder = append(instOrder, key)
				}
				g.types[c.Type] = true
				g.byInstance[li.Name] = c.Value
				if s, ok := setters[leafOf(c.Path)]; ok {
					g.display = s
				}
				continue
			}
			key := fr.File + "|" + c.Path
			if _, ok := sharedGroups[key]; ok {
				continue
			}
			sharedGroups[key] = &sharedGroup{
				file: fr.File, path: c.Path, format: c.Format, line: c.Line,
				typ: c.Type, item: c.itemType, name: c.Name, value: c.Value,
				order: len(sharedOrder),
			}
			sharedOrder = append(sharedOrder, key)
			if !sharedSeen[fr.File] {
				sharedSeen[fr.File] = true
				res.SharedFiles = append(res.SharedFiles, fr.File)
			}
		}
	}

	// Instance-layer parameters: one per (rel, path), bound via {folder}/rel.
	var params []model.Parameter
	for _, key := range instOrder {
		g := instGroups[key]
		p := model.Parameter{
			Name:        g.name,
			DisplayName: g.display,
			Category:    categoryFor(g.name),
			Type:        dominantType(g.types),
			ItemType:    g.itemType,
			Scope:       model.ScopeInstance,
			Secret:      looksSecret(g.name),
			Bindings:    []model.Binding{{File: "{folder}/" + g.rel, Path: g.path, Format: g.format, Line: g.line}},
			Observed:    g.byInstance,
		}
		if v, same := commonValue(g.byInstance, len(res.Instances)); same {
			p.Default = v
		}
		params = append(params, p)
	}

	// Merge instance-layer parameters that are the SAME logical setting in
	// several locations (e.g. a namespace repeated in values.yaml and an XML
	// file). Conservative rule: identical LEAF name AND identical values in
	// every instance - a coincidence across the whole fleet is implausible.
	params = mergeIdentical(params, func(p model.Parameter) string {
		g := instGroups[instKeyOf(p)]
		return leafOf(p.Name) + "|" + fmt.Sprintf("%v", sortedValues(g.byInstance))
	})

	// Shared (base-layer) parameters: literal bindings, global scope.
	sharedParams := make([]model.Parameter, 0, len(sharedOrder))
	for _, key := range sharedOrder {
		g := sharedGroups[key]
		sharedParams = append(sharedParams, model.Parameter{
			Name:     g.name,
			Category: categoryFor(g.name),
			Type:     g.typ,
			ItemType: g.item,
			Scope:    model.ScopeGlobal,
			Secret:   looksSecret(g.name),
			Default:  g.value,
			Bindings: []model.Binding{{File: g.file, Path: g.path, Format: g.format, Layer: model.LayerBase, Line: g.line}},
		})
	}
	sharedParams = mergeIdentical(sharedParams, func(p model.Parameter) string {
		return p.Name + "|" + fmt.Sprintf("%v", p.Default)
	})

	// Unify base and instance layers: when a shared file carries the same
	// setting an instance-layer parameter manages (same in-file path and leaf
	// name - the kustomize base + overlay-patch shape), the shared location
	// becomes the parameter's BASE binding: instances without an override
	// inherit the base value, exactly as their tooling merges it.
	remaining := sharedParams[:0]
	for _, sp := range sharedParams {
		merged := false
		for i := range params {
			if leafOf(params[i].Name) == leafOf(sp.Name) && params[i].Bindings[0].Path == sp.Bindings[0].Path {
				// No Default here: the base file supplies the fallback live.
				params[i].Bindings = append(params[i].Bindings, sp.Bindings...)
				merged = true
				break
			}
		}
		if !merged {
			remaining = append(remaining, sp)
		}
	}
	params = append(params, remaining...)

	// Attach schema-derived validation and assign unique IDs. One schema cache
	// serves every parameter, so a shared schema file is read + parsed once.
	schemas := schemaCache{}
	used := map[string]bool{}
	for i := range params {
		attachSchema(root, schemas, &params[i], res.Instances)
		id := slugify(params[i].Name)
		for n := 2; used[id]; n++ {
			id = fmt.Sprintf("%s-%d", slugify(params[i].Name), n)
		}
		used[id] = true
		params[i].ID = id
	}

	res.Parameters = params
	return res, nil
}

// instKeyOf reconstructs the instGroups key for a single-binding instance
// parameter (used only inside the merge step, before bindings multiply).
func instKeyOf(p model.Parameter) string {
	b := p.Bindings[0]
	return strings.TrimPrefix(b.File, "{folder}/") + "|" + b.Path
}

// mergeIdentical collapses parameters with the same merge key into one
// parameter carrying all bindings, preserving order. The shortest name wins
// the display (e.g. "namespace" over "net.namespace" for the same setting).
func mergeIdentical(params []model.Parameter, keyFn func(model.Parameter) string) []model.Parameter {
	index := map[string]int{}
	var out []model.Parameter
	for _, p := range params {
		k := keyFn(p)
		if i, ok := index[k]; ok {
			out[i].Bindings = append(out[i].Bindings, p.Bindings...)
			if len(p.Name) < len(out[i].Name) {
				out[i].Name = p.Name
			}
			continue
		}
		index[k] = len(out)
		out = append(out, p)
	}
	return out
}

// candidate is plugin.Candidate plus the folded list element type.
type candidate struct {
	Name     string
	Path     string
	Type     model.ParamType
	itemType model.ParamType
	Value    any
	Format   string
	Line     int
}

var indexSuffix = regexp.MustCompile(`\[\d+\]$`)

// foldLists folds indexed leaves (servers[0], servers[1], …) back into ONE
// list candidate, and passes scalars through. XML list candidates already
// arrive whole from the XML parser.
func foldLists(cands []plugin.Candidate) []candidate {
	var out []candidate
	lists := map[string]int{} // folded path -> position in out
	for _, c := range cands {
		if !indexSuffix.MatchString(c.Path) {
			out = append(out, candidate{Name: c.Name, Path: c.Path, Type: c.Type, Value: c.Value, Format: c.Format, Line: c.Line})
			continue
		}
		base := indexSuffix.ReplaceAllString(c.Path, "")
		if i, ok := lists[base]; ok {
			out[i].Value = append(out[i].Value.([]any), c.Value)
			continue
		}
		lists[base] = len(out)
		out = append(out, candidate{
			Name:     strings.TrimPrefix(strings.TrimPrefix(base, "$."), "$"),
			Path:     base,
			Type:     model.TypeList,
			itemType: c.Type,
			Value:    []any{c.Value},
			Format:   c.Format,
			Line:     c.Line, // the list's first element line
		})
	}
	return out
}

func leafOf(path string) string {
	s := indexSuffix.ReplaceAllString(path, "")
	if i := strings.LastIndexAny(s, "./"); i >= 0 {
		return s[i+1:]
	}
	return s
}

// dominantType picks the group's type: mixed inference degrades to string,
// except a lone extra "string" alongside a specific type keeps the specific
// one (e.g. an unset field in one instance).
func dominantType(types map[model.ParamType]bool) model.ParamType {
	if len(types) == 1 {
		for t := range types {
			return t
		}
	}
	delete(types, model.TypeString)
	if len(types) == 1 {
		for t := range types {
			return t
		}
	}
	return model.TypeString
}

// commonValue returns the value shared by EVERY instance (as a default), and
// whether such a value exists.
func commonValue(byInstance map[string]any, instanceCount int) (any, bool) {
	if len(byInstance) == 0 || len(byInstance) < instanceCount {
		return nil, false
	}
	var first any
	started := false
	for _, v := range byInstance {
		if !started {
			first, started = v, true
			continue
		}
		if fmt.Sprintf("%v", v) != fmt.Sprintf("%v", first) {
			return nil, false
		}
	}
	return first, true
}

func sortedValues(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+fmt.Sprintf("%v", m[k]))
	}
	return out
}

// categoryFor proposes a category from the setting's first name segment.
func categoryFor(name string) string {
	i := strings.IndexAny(name, "./")
	if i <= 0 {
		return "General"
	}
	seg := name[:i]
	return strings.ToUpper(seg[:1]) + seg[1:]
}

// settersFor reads a file and returns its kpt setter map (key -> setter).
func settersFor(root, file string) map[string]string {
	b, err := osReadFile(root, file)
	if err != nil {
		return nil
	}
	return layout.SettersIn(b)
}

// skipFile drops files that describe structure rather than configuration:
// schemas, kustomization manifests, Kptfiles, and Helm chart plumbing are
// tooling metadata, not settings anyone tunes per instance. Helm templates
// under templates/ are Go-templated manifests (rendered, not edited), so the
// whole directory is skipped; the chart's values.yaml is kept - it holds the
// tunable defaults.
func skipFile(file string) bool {
	lower := strings.ToLower(file)
	// Anything inside a Helm templates/ or crds/ directory is generated or
	// schema material, never a tuned value.
	for _, seg := range []string{"/templates/", "/crds/"} {
		if strings.Contains(lower, seg) {
			return true
		}
	}
	if strings.HasPrefix(lower, "templates/") || strings.HasPrefix(lower, "crds/") {
		return true
	}
	base := lower[strings.LastIndex(lower, "/")+1:]
	switch base {
	case "kustomization.yaml", "kustomization.yml", "kptfile",
		"chart.yaml", "chart.lock":
		return true
	}
	return strings.HasSuffix(base, ".schema.json")
}

// structuralKey drops the top-level Kubernetes identity fields present in
// almost any KRM document, regardless of whether the file is a full manifest.
func structuralKey(path string) bool {
	switch stripDoc(path) {
	case "$.apiVersion", "$.kind":
		return true
	}
	return false
}

// stripDoc removes a leading multi-document selector ("[1]$.spec" -> "$.spec")
// so the structural/envelope checks compare against canonical paths regardless
// of which document in a stream a candidate came from.
func stripDoc(path string) string {
	if _, rest, ok := pathedit.DocIndex(path); ok {
		return rest
	}
	return path
}

// k8sManifest reports whether a scanned file is a Kubernetes manifest: it has
// both a top-level apiVersion and kind. Helm values files and other plain
// config do not, so their fields are left untouched.
func k8sManifest(cands []candidate) bool {
	var hasAPI, hasKind bool
	for _, c := range cands {
		switch stripDoc(c.Path) {
		case "$.apiVersion":
			hasAPI = true
		case "$.kind":
			hasKind = true
		}
	}
	return hasAPI && hasKind
}

// k8sEnvelopePrefixes are the metadata-bookkeeping and cluster-reported
// subtrees of a Kubernetes object: identity and status, never tunable config.
var k8sEnvelopePrefixes = []string{
	"$.metadata.name", "$.metadata.namespace", "$.metadata.labels",
	"$.metadata.annotations", "$.metadata.creationTimestamp", "$.metadata.resourceVersion",
	"$.metadata.uid", "$.metadata.generation", "$.metadata.finalizers",
	"$.metadata.ownerReferences", "$.metadata.managedFields", "$.metadata.selfLink",
	"$.status",
}

// k8sStructural reports whether a path is Kubernetes envelope/structure inside
// a manifest file - the resource's identity and bookkeeping - rather than a
// value someone tunes per instance.
func k8sStructural(path string) bool {
	path = stripDoc(path)
	if path == "$.apiVersion" || path == "$.kind" {
		return true
	}
	for _, pfx := range k8sEnvelopePrefixes {
		if path == pfx || strings.HasPrefix(path, pfx+".") || strings.HasPrefix(path, pfx+"[") {
			return true
		}
	}
	return false
}

var secretRe = regexp.MustCompile(`(?i)(password|passwd|secret|token|api[-_]?key|private[-_]?key|credential)`)

func looksSecret(name string) bool { return secretRe.MatchString(leafOf(name)) }

func slugify(name string) string {
	s := strings.ToLower(name)
	s = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		default:
			return '-'
		}
	}, s)
	return strings.Trim(strings.Join(strings.FieldsFunc(s, func(r rune) bool { return r == '-' }), "-"), "-")
}

// Ignore re-exports the project ignore type for callers.
type Ignore = project.Ignore
