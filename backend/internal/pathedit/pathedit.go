// Package pathedit is the single engine for reading and surgically editing
// values inside configuration documents. It understands three formats:
//
//   - YAML - comment-preserving node-tree edits: only the addressed value
//     changes; comments, key order, and unmanaged content stay byte-for-byte.
//   - JSON - the same, by splicing the new literal over the old one in the
//     original bytes. A structural edit (a new key, a removal) has to re-emit
//     the document, and then walks the same order-preserving node tree (Go maps
//     would re-sort every key), keeping the file's own indentation, number
//     literals and string escapes.
//   - XML  - etree-based element/attribute edits; list parameters map to
//     repeated sibling elements.
//
// The byte-for-byte promise is the point, not a nicety: a value edit that
// re-states lines it did not change buries the one line it did in a review
// diff hundreds of lines long, and the reviewer approves it anyway.
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
	"strings"

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
	// yamls holds every document in the stream (files with "---" separators
	// carry more than one); a path's document selector picks among them.
	yamls []*yaml.Node
	xml   *etree.Document
	// raw is the document's own bytes, kept for the two things the parsed trees
	// cannot answer on their own: XML has no line information at all (see
	// xmlLine), and narrowing a YAML hit to the columns its value occupies means
	// reading the source line (see Span).
	raw   []byte
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
		return &Document{xml: d, raw: doc}, nil
	}
	docs, err := decodeDocs(doc)
	if err != nil {
		return nil, err
	}
	return &Document{yamls: docs, raw: doc}, nil
}

// yamlDoc returns the node tree for the document a path selects (index 0 when
// the path carries no selector), plus the path with the selector stripped.
func (d *Document) yamlDoc(path string) (*yaml.Node, string, bool) {
	idx, rest, _ := DocIndex(path)
	if idx >= len(d.yamls) {
		return nil, rest, false
	}
	return d.yamls[idx], rest, true
}

// Get reads the value at path from an already-parsed Document.
func (d *Document) Get(path string) (any, bool, error) {
	if d == nil || d.empty {
		return nil, false, nil
	}
	if d.xml != nil {
		return getXMLFromDoc(d.xml, path)
	}
	root, rest, ok := d.yamlDoc(path)
	if !ok {
		return nil, false, nil
	}
	return getTreeFromRoot(root, rest)
}

// Line returns the 1-based source line of the value at path from a parsed
// Document: the node tree for YAML and JSON, a scan of the original bytes for
// XML (etree keeps no line numbers). Used to jump straight to where a value
// lives, and to mark the lines a file's managed values sit on.
func (d *Document) Line(path string) (int, bool) {
	if d == nil || d.empty {
		return 0, false
	}
	if d.xml != nil {
		return xmlLine(d.raw, path)
	}
	if len(d.yamls) == 0 {
		return 0, false
	}
	root, rest, ok := d.yamlDoc(path)
	if !ok {
		return 0, false
	}
	return lineFromRoot(root, rest)
}

// Span locates a value precisely enough to point AT it rather than at the line
// it shares with a key: the 1-based line, and the 1-based column range the value
// token occupies. col/endCol are 0 when only the line could be determined (a
// block scalar, an XML shape the scan cannot narrow), and the caller falls back
// to marking the line.
func (d *Document) Span(path string) (line, col, endCol int, ok bool) {
	if d == nil || d.empty {
		return 0, 0, 0, false
	}
	if d.xml != nil {
		l, found := xmlLine(d.raw, path)
		if !found || l <= 0 {
			return 0, 0, 0, false
		}
		c, e := xmlValueColumns(d.raw, l, path)
		return l, c, e, true
	}
	if len(d.yamls) == 0 {
		return 0, 0, 0, false
	}
	root, rest, found := d.yamlDoc(path)
	if !found {
		return 0, 0, 0, false
	}
	segs, err := ParsePath(rest)
	if err != nil {
		return 0, 0, 0, false
	}
	cur := docRoot(root)
	if cur == nil {
		return 0, 0, 0, false
	}
	for _, seg := range segs {
		if cur = descend(cur, seg); cur == nil {
			return 0, 0, 0, false
		}
	}
	if cur.Line <= 0 {
		return 0, 0, 0, false
	}
	// A scalar's extent comes from the same token scanner the surgical writer
	// uses, so "where the value is" means one thing in this codebase.
	// A block scalar (|, >) starts at its marker and runs over the lines below,
	// so there is no single token to point at: the line is the honest answer.
	block := cur.Style == yaml.LiteralStyle || cur.Style == yaml.FoldedStyle
	if cur.Kind == yaml.ScalarNode && cur.Column > 0 && !block {
		lines := strings.Split(string(d.raw), "\n")
		if i := cur.Line - 1; i >= 0 && i < len(lines) {
			if end, found := scalarTokenExtent(lines[i], cur.Column-1, cur.Style); found {
				return cur.Line, cur.Column, end + 1, true
			}
		}
	}
	return cur.Line, 0, 0, true
}

// xmlValueColumns narrows an XML hit to the value on its line: the text between
// the tags for an element, or the quoted text for an attribute. A shape it
// cannot read leaves the columns at zero and the whole line is marked instead.
func xmlValueColumns(raw []byte, line int, path string) (col, endCol int) {
	lines := strings.Split(string(raw), "\n")
	if line-1 < 0 || line-1 >= len(lines) {
		return 0, 0
	}
	text := lines[line-1]
	if attr, _, isAttr := splitAttrPath(path); isAttr {
		if i := strings.Index(text, attr+"=\""); i >= 0 {
			start := i + len(attr) + 2
			if j := strings.IndexByte(text[start:], '"'); j > 0 {
				return start + 1, start + j + 1
			}
		}
		return 0, 0
	}
	open := strings.IndexByte(text, '>')
	if open < 0 {
		return 0, 0
	}
	close := strings.Index(text[open+1:], "<")
	if close <= 0 {
		return 0, 0
	}
	return open + 2, open + 1 + close + 1
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
