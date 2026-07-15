package parsers

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"gopkg.in/yaml.v3"
)

// YAMLParser extracts parameters from YAML documents (including Helm values,
// Flux, and kpt/KRM files, which are YAML at rest).
type YAMLParser struct{}

func (YAMLParser) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID:          "builtin.yaml",
		Name:        "YAML",
		Version:     "1.0.0",
		Kind:        plugin.KindIngestParser,
		Description: "Extracts parameters from YAML files (values.yaml, Flux, kpt/KRM).",
	}
}

func (YAMLParser) Detect(path string, _ []byte) bool {
	p := strings.ToLower(path)
	return strings.HasSuffix(p, ".yaml") || strings.HasSuffix(p, ".yml")
}

func (YAMLParser) Extract(file string, content []byte) ([]plugin.Candidate, error) {
	// Decode into a yaml.Node so every scalar carries its source line, which
	// the onboarding UI shows beside each value. A plain any-decode loses that.
	var doc yaml.Node
	if err := yaml.Unmarshal(content, &doc); err != nil {
		return nil, err
	}
	var out []plugin.Candidate
	root := &doc
	if root.Kind == yaml.DocumentNode && len(root.Content) > 0 {
		root = root.Content[0]
	}
	flattenNode(root, "$", file, &out)
	return out, nil
}

// flattenNode walks a yaml.Node tree, emitting one candidate per scalar leaf
// with its 1-based source line. Mapping keys and their value nodes are paired;
// sequence items are indexed.
func flattenNode(n *yaml.Node, path, file string, out *[]plugin.Candidate) {
	switch n.Kind {
	case yaml.MappingNode:
		for i := 0; i+1 < len(n.Content); i += 2 {
			flattenNode(n.Content[i+1], path+"."+n.Content[i].Value, file, out)
		}
	case yaml.SequenceNode:
		for i, c := range n.Content {
			flattenNode(c, fmt.Sprintf("%s[%d]", path, i), file, out)
		}
	case yaml.AliasNode:
		if n.Alias != nil {
			flattenNode(n.Alias, path, file, out)
		}
	case yaml.ScalarNode:
		*out = append(*out, plugin.Candidate{
			Name:   nameFromPath(path),
			Path:   path,
			Type:   inferType(scalarValue(n)),
			Value:  scalarValue(n),
			File:   file,
			Format: "yaml",
			Line:   n.Line,
		})
	}
}

// scalarValue decodes a scalar node to its Go value so type inference and the
// displayed value match a plain decode.
func scalarValue(n *yaml.Node) any {
	var v any
	if err := n.Decode(&v); err != nil {
		return n.Value
	}
	return v
}

// JSONParser extracts parameters from JSON documents.
type JSONParser struct{}

func (JSONParser) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID:          "builtin.json",
		Name:        "JSON",
		Version:     "1.0.0",
		Kind:        plugin.KindIngestParser,
		Description: "Extracts parameters from JSON configuration files.",
	}
}

func (JSONParser) Detect(path string, _ []byte) bool {
	return strings.HasSuffix(strings.ToLower(path), ".json")
}

func (JSONParser) Extract(file string, content []byte) ([]plugin.Candidate, error) {
	var root any
	if err := json.Unmarshal(content, &root); err != nil {
		return nil, err
	}
	var out []plugin.Candidate
	flatten(root, "$", file, "json", &out)
	return out, nil
}

