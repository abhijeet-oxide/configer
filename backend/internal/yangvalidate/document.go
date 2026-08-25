package yangvalidate

// A configuration file has to become a TREE OF NAMED NODES before a model can
// be held against it, and it has to keep two things while it does: the dotted
// path each value lives at (so a finding can be pointed at the exact place the
// editor opens) and the source line (so a reviewer can see it).
//
// YAML and JSON go through the yaml node tree - the same route pathedit takes,
// and for the same reason: JSON parsed into a Go map has no order to speak of,
// and a repeated structure whose entries have been shuffled is a different
// document. XML goes through etree.

import (
	"strconv"
	"strings"

	"github.com/beevik/etree"
	"gopkg.in/yaml.v3"

	"github.com/abhijeet-oxide/configer/backend/internal/pathedit"
)

// Node is one addressable place in a configuration document.
type Node struct {
	// Name is the element/key name with any module prefix stripped, which is
	// the only spelling a YANG model would recognize.
	Name string
	// Path is the pathedit-compatible route to this node inside its own file.
	Path string
	Line int
	// Scalar holds the value when this node is a leaf.
	Scalar   any
	IsScalar bool
	// Repeated marks a node the document spelled as a collection - a YAML
	// sequence, a JSON array, repeated XML siblings - whether or not it holds
	// anything. An EMPTY collection is the whole point of the flag: read as
	// "no entries" it looked like an ordinary empty node, and a list the model
	// requires at least one entry in slipped through saying nothing.
	Repeated bool
	// Entries are the members of a repeated node. A node has Entries or
	// Children, never both.
	Entries  []*Node
	Children []*Node
	// File is the repo-relative file the node came from, kept per node because
	// a validation scope merges several files into one tree.
	File string
}

// Leaf reports whether the node holds a value rather than a structure.
func (n *Node) Leaf() bool { return n != nil && n.IsScalar }

// Child returns the first child with the given (prefix-stripped) name.
func (n *Node) Child(name string) *Node {
	if n == nil {
		return nil
	}
	for _, c := range n.Children {
		if c.Name == name {
			return c
		}
	}
	return nil
}

// Load parses one configuration document into a node tree. The returned node
// is a synthetic root holding the document's top-level nodes; it has no name
// of its own because a file's outermost brace is not a thing the model names.
func Load(file, format string, content []byte) (*Node, error) {
	root := &Node{Name: "", Path: "$", File: file}
	if len(strings.TrimSpace(string(content))) == 0 {
		return root, nil
	}
	if strings.EqualFold(format, "xml") {
		return root, loadXML(root, content)
	}
	return root, loadYAML(root, content)
}

func loadYAML(root *Node, content []byte) error {
	var doc yaml.Node
	if err := yaml.Unmarshal(content, &doc); err != nil {
		return err
	}
	if len(doc.Content) == 0 {
		return nil
	}
	// Only the first document of a stream is validated. A multi-document file
	// is a Kubernetes convention rather than a datastore, and a model that
	// covers one of the documents has nothing to say about the others.
	root.Children = yamlChildren(root.File, "$", doc.Content[0], 0)
	return nil
}

// yamlChildren turns a mapping node into named children. A non-mapping at the
// top of a document (a bare sequence, a scalar) has no names in it, so there is
// nothing for a model to match and nothing is produced.
func yamlChildren(file, base string, n *yaml.Node, depth int) []*Node {
	if n == nil || depth > maxDepth {
		return nil
	}
	if n.Kind == yaml.DocumentNode && len(n.Content) > 0 {
		return yamlChildren(file, base, n.Content[0], depth+1)
	}
	if n.Kind != yaml.MappingNode {
		return nil
	}
	var out []*Node
	for i := 0; i+1 < len(n.Content); i += 2 {
		key, val := n.Content[i], n.Content[i+1]
		name := key.Value
		if name == "" {
			continue
		}
		out = append(out, yamlNode(file, pathedit.JoinKey(base, name), bare(name), val, depth+1))
	}
	return out
}

func yamlNode(file, path, name string, val *yaml.Node, depth int) *Node {
	node := &Node{Name: name, Path: path, Line: val.Line, File: file}
	switch val.Kind {
	case yaml.MappingNode:
		node.Children = yamlChildren(file, path, val, depth)
	case yaml.SequenceNode:
		node.Repeated = true
		for i, item := range val.Content {
			entryPath := path + "[" + strconv.Itoa(i) + "]"
			entry := yamlNode(file, entryPath, name, item, depth+1)
			node.Entries = append(node.Entries, entry)
		}
	case yaml.AliasNode:
		if val.Alias != nil {
			return yamlNode(file, path, name, val.Alias, depth+1)
		}
	default:
		node.IsScalar = true
		node.Scalar = scalarValue(val)
	}
	return node
}

// scalarValue decodes a YAML scalar to the Go value it stands for, so a number
// compares as a number. A tag the decoder cannot read comes back as its text,
// which is what every rule in this product falls back to anyway.
func scalarValue(n *yaml.Node) any {
	var v any
	if err := n.Decode(&v); err != nil {
		return n.Value
	}
	return v
}

func loadXML(root *Node, content []byte) error {
	doc := etree.NewDocument()
	if err := doc.ReadFromBytes(content); err != nil {
		return err
	}
	lines := lineIndex(content)
	if el := doc.Root(); el != nil {
		root.Children = []*Node{xmlNode(root.File, "/"+el.Tag, el, lines, 0)}
	}
	return nil
}

func xmlNode(file, path string, el *etree.Element, lines map[string]int, depth int) *Node {
	node := &Node{Name: bare(el.Tag), Path: path, File: file, Line: lines[el.Tag]}
	if depth > maxDepth {
		return node
	}
	// Attributes are addressed with "@" in an XPath, and a YANG model has no
	// attributes at all - but a document may still carry them, and dropping
	// them silently would make an attribute-carried value invisible.
	for _, attr := range el.Attr {
		if attr.Space == "xmlns" || attr.Key == "xmlns" {
			continue
		}
		node.Children = append(node.Children, &Node{
			Name: bare(attr.Key), Path: path + "/@" + attr.Key, File: file,
			IsScalar: true, Scalar: attr.Value, Line: node.Line,
		})
	}
	// Siblings of one name are the entries of a repeated node, exactly as a
	// YAML sequence is - the model addresses them the same way.
	byTag := map[string][]*etree.Element{}
	var order []string
	for _, child := range el.ChildElements() {
		if _, seen := byTag[child.Tag]; !seen {
			order = append(order, child.Tag)
		}
		byTag[child.Tag] = append(byTag[child.Tag], child)
	}
	for _, tag := range order {
		group := byTag[tag]
		if len(group) == 1 {
			node.Children = append(node.Children, xmlNode(file, path+"/"+tag, group[0], lines, depth+1))
			continue
		}
		repeated := &Node{Name: bare(tag), Path: path + "/" + tag, File: file, Line: lines[tag], Repeated: true}
		for i, child := range group {
			entryPath := path + "/" + tag + "[" + strconv.Itoa(i+1) + "]"
			repeated.Entries = append(repeated.Entries, xmlNode(file, entryPath, child, lines, depth+1))
		}
		node.Children = append(node.Children, repeated)
	}
	if len(node.Children) == 0 {
		node.IsScalar = true
		node.Scalar = strings.TrimSpace(el.Text())
	}
	return node
}

// lineIndex records the first line each tag appears on. etree keeps no line
// information, and a finding with no line is a finding somebody has to go
// looking for. First occurrence is an approximation and is treated as one: it
// points a reader at the right area of the file, never at an exact column.
func lineIndex(content []byte) map[string]int {
	out := map[string]int{}
	line := 1
	src := string(content)
	for i := 0; i < len(src); i++ {
		switch src[i] {
		case '\n':
			line++
		case '<':
			j := i + 1
			if j < len(src) && (src[j] == '/' || src[j] == '?' || src[j] == '!') {
				continue
			}
			k := j
			for k < len(src) && !strings.ContainsRune(" \t\r\n>/", rune(src[k])) {
				k++
			}
			if tag := src[j:k]; tag != "" {
				if _, seen := out[tag]; !seen {
					out[tag] = line
				}
			}
		}
	}
	return out
}

// maxDepth stops a hostile or malformed document from recursing without end.
const maxDepth = 128

// bare strips a module or namespace prefix. RFC 7951 JSON spells a node
// "module:leaf" and XML spells it "ns:leaf"; a YANG model has never seen
// either, and the bare name is the only thing the two sides share.
func bare(s string) string {
	if i := strings.IndexByte(s, ':'); i > 0 {
		return s[i+1:]
	}
	return s
}
