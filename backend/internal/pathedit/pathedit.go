// Package pathedit is the single engine for reading and surgically editing
// values inside configuration documents. It understands three formats:
//
//   - YAML — comment-preserving node-tree edits: only the addressed value
//     changes; comments, key order, and unmanaged content stay byte-for-byte.
//   - JSON — the same order-preserving node tree, re-emitted as JSON (Go maps
//     would re-sort keys and produce noisy diffs).
//   - XML  — etree-based element/attribute edits; list parameters map to
//     repeated sibling elements.
//
// Paths are dotted for YAML/JSON ("$.service.ip", "servers[2]",
// "rules[name=ssh].port") and XPath-like for XML ("/network/service/ip",
// "/network/tls/@minVersion"). Removals prune now-empty parents so absence is
// total: no key, no line, no empty husk remains.
//
// Every write path in Configer — cell edits, instance scaffolding, file-mode
// previews — funnels through this package so edit semantics can never drift
// between features.
package pathedit

import "github.com/abhijeet-oxide/configer/backend/internal/model"

// Get reads the value at path inside doc. The second return reports whether
// the path resolved to a value.
func Get(doc []byte, format, path string) (any, bool, error) {
	if normFormat(format) == "xml" {
		return getXML(doc, path)
	}
	return getTree(doc, path)
}

// Set returns doc with value written at path, creating the file structure and
// any intermediate containers as needed. ptype selects list semantics for XML
// (repeated sibling elements).
func Set(doc []byte, format, path string, ptype model.ParamType, value any) (string, error) {
	switch normFormat(format) {
	case "xml":
		return editXML(doc, path, ptype, value, false)
	case "json":
		return setTree(doc, path, value, "json")
	default:
		return setTree(doc, path, value, "yaml")
	}
}

// Remove returns doc with the value at path removed and now-empty parents
// pruned. Removing a path that is not present is a no-op.
func Remove(doc []byte, format, path string, ptype model.ParamType) (string, error) {
	switch normFormat(format) {
	case "xml":
		return editXML(doc, path, ptype, nil, true)
	case "json":
		return removeTree(doc, path, "json")
	default:
		return removeTree(doc, path, "yaml")
	}
}

func normFormat(format string) string {
	switch format {
	case "yml", "":
		return "yaml"
	default:
		return format
	}
}
