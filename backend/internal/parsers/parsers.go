// Package parsers provides built-in IngestParser implementations for the
// common configuration formats. Each parser flattens a source document into
// leaf Candidate parameters whose Path locates them within the file.
package parsers

import (
	"fmt"
	"net"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/pathedit"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
)

// inferType guesses a parameter type from a scalar value.
func inferType(v any) model.ParamType {
	switch t := v.(type) {
	case bool:
		return model.TypeBoolean
	case int, int64:
		return model.TypeInteger
	case float64:
		// YAML/JSON numbers decode as float64; treat whole numbers as integers.
		if t == float64(int64(t)) {
			return model.TypeInteger
		}
		return model.TypeNumber
	case string:
		if ip := net.ParseIP(t); ip != nil && ip.To4() != nil {
			return model.TypeIPv4
		}
		if _, _, err := net.ParseCIDR(t); err == nil {
			return model.TypeCIDR
		}
		return model.TypeString
	default:
		return model.TypeString
	}
}

// nameFromPath derives a dotted human name from a JSONPath-like path: the
// mapping keys, with array indices dropped (they locate an element, they do not
// name the setting) and a QUOTED key kept whole - it is a key the dotted form
// could not spell, not a subscript, and dropping it would name the parameter
// after its parent. A leading multi-document selector ("[1]$.spec.port" ->
// "spec.port") goes too: the name is the logical setting, not which document in
// the stream carries it.
//
// The steps come from pathedit.Segments, which is also what the UI reads to
// nest the name tree - so a name and its segmentation can never disagree.
func nameFromPath(path string) string {
	return strings.Join(pathedit.Segments("yaml", path), ".")
}

// flatten walks a decoded JSON/YAML value and appends leaf candidates.
func flatten(node any, path, file, format string, out *[]plugin.Candidate) {
	switch n := node.(type) {
	case map[string]any:
		for k, v := range n {
			flatten(v, pathedit.JoinKey(path, k), file, format, out)
		}
	case map[any]any: // yaml.v3 can yield this for non-string keys
		for k, v := range n {
			flatten(v, pathedit.JoinKey(path, fmt.Sprintf("%v", k)), file, format, out)
		}
	case []any:
		for i, v := range n {
			flatten(v, fmt.Sprintf("%s[%d]", path, i), file, format, out)
		}
	default:
		// scalar leaf
		*out = append(*out, plugin.Candidate{
			Name:   nameFromPath(path),
			Path:   path,
			Type:   inferType(node),
			Value:  node,
			File:   file,
			Format: format,
		})
	}
}
