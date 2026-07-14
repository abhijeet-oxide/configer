package discovery

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/pathedit"
)

// Schema auto-detection: when a JSON Schema ships next to a configuration
// file (values.schema.json, <file>.schema.json, or .configer/schemas/…), its
// constraints become the parameter's validation rules — enforced on every
// edit from then on. User-defined rules (RuleEditor) can still override them
// later; they live in the same Validation struct.

func osReadFile(root, rel string) ([]byte, error) {
	return os.ReadFile(filepath.Join(root, rel))
}

// attachSchema fills p.Validation (and refines p.Type) from a schema file
// covering the parameter's first binding, when one exists.
func attachSchema(root string, p *model.Parameter, instances []model.Instance) {
	// JSON Schema does not describe XML documents: use the parameter's first
	// YAML/JSON binding (a deduplicated parameter may lead with an XML one).
	var b model.Binding
	found := false
	for _, cand := range p.Bindings {
		if cand.Format != "xml" {
			b, found = cand, true
			break
		}
	}
	if !found {
		return
	}
	// A templated binding may find its schema in ANY instance's folder (teams
	// often keep one schema next to one canonical instance).
	concretes := []string{b.File}
	if strings.Contains(b.File, "{") {
		concretes = concretes[:0]
		for _, inst := range instances {
			concretes = append(concretes, b.ForInstance(inst).File)
		}
	}

	for _, concrete := range concretes {
		for _, schemaRel := range schemaCandidates(concrete) {
			raw, err := osReadFile(root, schemaRel)
			if err != nil {
				continue
			}
			var schema map[string]any
			if json.Unmarshal(raw, &schema) != nil {
				continue
			}
			node, required := lookupSchema(schema, b.Path)
			if node == nil {
				continue
			}
			applySchema(p, node, required)
			p.Validation.SchemaRef = schemaRel
			return
		}
	}
}

// schemaCandidates lists where a schema for file conventionally lives.
func schemaCandidates(file string) []string {
	dir := filepath.ToSlash(filepath.Dir(file))
	base := filepath.Base(file)
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	joined := func(parts ...string) string { return filepath.ToSlash(filepath.Join(parts...)) }
	return []string{
		joined(dir, stem+".schema.json"),
		joined(dir, "values.schema.json"),
		joined(".configer", "schemas", stem+".schema.json"),
		joined(".configer", "schemas", base+".schema.json"),
	}
}

// lookupSchema walks a JSON Schema's properties along a dotted value path and
// returns the leaf's schema node plus whether the leaf is required.
func lookupSchema(schema map[string]any, path string) (map[string]any, bool) {
	segs, err := pathedit.ParsePath(path)
	if err != nil {
		return nil, false
	}
	cur := schema
	required := false
	for i, seg := range segs {
		if seg.Key == "" {
			continue
		}
		props, _ := cur["properties"].(map[string]any)
		if props == nil {
			return nil, false
		}
		next, _ := props[seg.Key].(map[string]any)
		if next == nil {
			return nil, false
		}
		if i == len(segs)-1 {
			if reqList, _ := cur["required"].([]any); reqList != nil {
				for _, r := range reqList {
					if r == seg.Key {
						required = true
					}
				}
			}
		}
		cur = next
		// A step into a list continues through the element schema.
		if seg.Index >= 0 || seg.SelKey != "" {
			if items, _ := cur["items"].(map[string]any); items != nil {
				cur = items
			}
		}
	}
	return cur, required
}

// applySchema maps JSON Schema constraints onto the parameter's validation.
func applySchema(p *model.Parameter, node map[string]any, required bool) {
	v := &p.Validation
	v.Required = v.Required || required

	if t, _ := node["type"].(string); t != "" {
		switch t {
		case "integer":
			p.Type = model.TypeInteger
		case "number":
			p.Type = model.TypeNumber
		case "boolean":
			p.Type = model.TypeBoolean
		case "array":
			p.Type = model.TypeList
			if items, _ := node["items"].(map[string]any); items != nil {
				if it, _ := items["type"].(string); it == "integer" {
					p.ItemType = model.TypeInteger
				} else if it == "number" {
					p.ItemType = model.TypeNumber
				} else if it == "boolean" {
					p.ItemType = model.TypeBoolean
				}
			}
		}
	}
	if enum, _ := node["enum"].([]any); len(enum) > 0 {
		p.Type = model.TypeEnum
		v.Enum = v.Enum[:0]
		for _, e := range enum {
			v.Enum = append(v.Enum, strFromAny(e))
		}
	}
	if pat, _ := node["pattern"].(string); pat != "" && v.Pattern == "" {
		v.Pattern = pat
	}
	if f, ok := numFromAny(node["minimum"]); ok && v.Min == nil {
		v.Min = &f
	}
	if f, ok := numFromAny(node["maximum"]); ok && v.Max == nil {
		v.Max = &f
	}
	if n, ok := intFromAny(node["minLength"]); ok && v.MinLength == nil {
		v.MinLength = &n
	}
	if n, ok := intFromAny(node["maxLength"]); ok && v.MaxLength == nil {
		v.MaxLength = &n
	}
	if n, ok := intFromAny(node["minItems"]); ok && v.MinItems == nil {
		v.MinItems = &n
	}
	if n, ok := intFromAny(node["maxItems"]); ok && v.MaxItems == nil {
		v.MaxItems = &n
	}
	// Well-known format keywords map to the preset rule library.
	if format, _ := node["format"].(string); format != "" && v.Preset == "" {
		switch format {
		case "ipv4", "hostname", "uri", "email", "uuid":
			presets := map[string]string{"ipv4": "ipv4", "hostname": "hostname", "uri": "url", "email": "email", "uuid": "uuid"}
			v.Preset = presets[format]
		}
	}
}

func strFromAny(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func numFromAny(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok
}

func intFromAny(v any) (int, bool) {
	if f, ok := v.(float64); ok {
		return int(f), true
	}
	return 0, false
}
