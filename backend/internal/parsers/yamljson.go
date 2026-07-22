package parsers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
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
	//
	// A single file may hold SEVERAL YAML documents separated by "---" (the
	// Kubernetes norm: one manifest file bundling a Deployment, Service and
	// ConfigMap). Decode every document in the stream, not just the first, or
	// each file after the first "---" is silently dropped. When a stream holds
	// more than one document, each document's paths are prefixed with its
	// 0-based index ("[0]$.spec…", "[1]$.spec…") so identically named fields in
	// sibling documents stay distinct instead of colliding.
	dec := yaml.NewDecoder(bytes.NewReader(content))
	var docs []*yaml.Node
	for {
		var doc yaml.Node
		err := dec.Decode(&doc)
		if err == io.EOF {
			break
		}
		if err != nil {
			// Preserve the original single-document behavior: a parse error is
			// reported (and, for the first document, discovery skips the file).
			if len(docs) == 0 {
				return nil, err
			}
			break
		}
		root := &doc
		if root.Kind == yaml.DocumentNode && len(root.Content) > 0 {
			root = root.Content[0]
		}
		if root.Kind == 0 {
			continue // an empty document (e.g. trailing "---")
		}
		docs = append(docs, root)
	}

	var out []plugin.Candidate
	for i, root := range docs {
		prefix := "$"
		if len(docs) > 1 {
			prefix = fmt.Sprintf("[%d]$", i)
		}
		flattenNode(root, prefix, file, &out)
	}
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

