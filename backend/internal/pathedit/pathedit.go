// Package pathedit is the single engine for reading and surgically editing
// values inside configuration documents. It understands three formats:
//
//   - YAML - comment-preserving node-tree edits: only the addressed value
//     changes; comments, key order, and unmanaged content stay byte-for-byte.
//   - JSON - the same order-preserving node tree, re-emitted as JSON (Go maps
//     would re-sort keys and produce noisy diffs).
//   - XML  - etree-based element/attribute edits; list parameters map to
//     repeated sibling elements.
//
// Paths are dotted for YAML/JSON ("$.service.ip", "servers[2]",
// "rules[name=ssh].port") and XPath-like for XML ("/network/service/ip",
// "/network/tls/@minVersion"). Removals prune now-empty parents so absence is
// total: no key, no line, no empty husk remains.
//
// Every write path in Configer - cell edits, instance scaffolding, file-mode
// previews - funnels through this package so edit semantics can never drift
// between features.
package pathedit

import (
	"github.com/abhijeet-oxide/configer/backend/internal/model"

	"github.com/beevik/etree"
	"gopkg.in/yaml.v3"
)

// Get reads the value at path inside doc. The second return reports whether
// the path resolved to a value.
func Get(doc []byte, format, path string) (any, bool, error) {
	if normFormat(format) == "xml" {
		return getXML(doc, path)
	}
	return getTree(doc, path)
}

// Document is a parsed configuration file that can answer many Get calls
// without re-parsing. Reading a whole grid resolves the same handful of files
// for every (parameter, instance) cell; parsing once and caching the tree
// turns thousands of repeated parses into one per file. Get is read-only and
// safe to call repeatedly; a Document must not be shared across writes.
type Document struct {
	yaml  *yaml.Node
	xml   *etree.Document
	empty bool
}

// Parse builds a reusable Document from raw bytes. An empty document answers
// every lookup with "not found".
func Parse(doc []byte, format string) (*Document, error) {
	if len(doc) == 0 {
		return &Document{empty: true}, nil
	}
	if normFormat(format) == "xml" {
		d := etree.NewDocument()
		if err := d.ReadFromBytes(doc); err != nil {
			return nil, err
		}
		return &Document{xml: d}, nil
	}
	var root yaml.Node
	if err := yaml.Unmarshal(doc, &root); err != nil {
		return nil, err
	}
	return &Document{yaml: &root}, nil
}

// Get reads the value at path from an already-parsed Document.
func (d *Document) Get(path string) (any, bool, error) {
	if d == nil || d.empty {
		return nil, false, nil
	}
	if d.xml != nil {
		return getXMLFromDoc(d.xml, path)
	}
	return getTreeFromRoot(d.yaml, path)
}

// Line returns the 1-based source line of the value at path from a parsed
// Document. It supports YAML and JSON (which share the node tree); XML has no
// per-node line and returns false. Used to jump straight to where a value lives.
func (d *Document) Line(path string) (int, bool) {
	if d == nil || d.empty || d.yaml == nil {
		return 0, false
	}
	return lineFromRoot(d.yaml, path)
}

// Line is the one-shot form: parse doc and return the value's source line.
func Line(doc []byte, format, path string) (int, bool) {
	if normFormat(format) == "xml" {
		return xmlLine(doc, path)
	}
	d, err := Parse(doc, format)
	if err != nil {
		return 0, false
	}
	return d.Line(path)
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
