package parsers

import (
	"encoding/json"
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
	var root any
	if err := yaml.Unmarshal(content, &root); err != nil {
		return nil, err
	}
	var out []plugin.Candidate
	flatten(normalize(root), "$", file, "yaml", &out)
	return out, nil
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

// normalize converts map[any]any (produced by yaml.v3 for some documents) into
// map[string]any recursively so downstream code can assume string keys.
func normalize(v any) any {
	switch n := v.(type) {
	case map[any]any:
		m := make(map[string]any, len(n))
		for k, val := range n {
			m[toString(k)] = normalize(val)
		}
		return m
	case map[string]any:
		m := make(map[string]any, len(n))
		for k, val := range n {
			m[k] = normalize(val)
		}
		return m
	case []any:
		for i := range n {
			n[i] = normalize(n[i])
		}
		return n
	default:
		return v
	}
}

func toString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return strings.TrimSpace(strings.Trim(strings.ReplaceAll(strings.ToLower(strings.TrimSpace(sprint(v))), " ", "_"), "\""))
}

func sprint(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
