package pathedit

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"gopkg.in/yaml.v3"
)

// The YAML and JSON engines share one node-tree implementation built on
// yaml.Node: yaml.v3 parses JSON too (JSON is a YAML subset) and the node tree
// preserves key order, comments and formatting context, so edits are surgical
// in both formats. YAML re-serializes through the yaml encoder; JSON through
// emitJSON, which walks the same tree and therefore keeps the file's key order
// (encoding/json maps would silently re-sort every key).

func getTree(doc []byte, path string) (any, bool, error) {
	if len(doc) == 0 {
		return nil, false, nil
	}
	if idx, rest, multi := DocIndex(path); multi {
		docs, err := decodeDocs(doc)
		if err != nil {
			return nil, false, err
		}
		if idx >= len(docs) {
			return nil, false, nil
		}
		return getTreeFromRoot(docs[idx], rest)
	}
	var root yaml.Node
	if err := yaml.Unmarshal(doc, &root); err != nil {
		return nil, false, err
	}
	return getTreeFromRoot(&root, path)
}

// decodeDocs decodes every YAML document in a stream (files with "---"
// separators) into its own node tree, in order. It backs multi-document reads
// and edits; a single-document file yields a one-element slice.
func decodeDocs(doc []byte) ([]*yaml.Node, error) {
	dec := yaml.NewDecoder(bytes.NewReader(doc))
	var out []*yaml.Node
	for {
		var n yaml.Node
		err := dec.Decode(&n)
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		out = append(out, &n)
	}
	return out, nil
}

// encodeDocs re-serializes a multi-document stream, emitting "---" separators
// between documents and preserving each document's comments and style.
func encodeDocs(docs []*yaml.Node, indent int) (string, error) {
	var b strings.Builder
	enc := yaml.NewEncoder(&b)
	enc.SetIndent(indent)
	for _, d := range docs {
		if err := enc.Encode(d); err != nil {
			return "", err
		}
	}
	if err := enc.Close(); err != nil {
		return "", err
	}
	return b.String(), nil
}

// getTreeFromRoot reads path from an already-parsed yaml.Node (the cached-doc
// path). Read-only: it never mutates the node.
func getTreeFromRoot(root *yaml.Node, path string) (any, bool, error) {
	segs, err := ParsePath(path)
	if err != nil {
		return nil, false, err
	}
	cur := docRoot(root)
	if cur == nil {
		return nil, false, nil
	}
	for _, seg := range segs {
		cur = descend(cur, seg)
		if cur == nil {
			return nil, false, nil
		}
	}
	var out any
	if err := cur.Decode(&out); err != nil {
		return nil, false, err
	}
	return out, true, nil
}

// lineFromRoot walks to the value node at path and returns its 1-based source
// line, reusing the same descent as Get so path semantics never diverge.
func lineFromRoot(root *yaml.Node, path string) (int, bool) {
	segs, err := ParsePath(path)
	if err != nil {
		return 0, false
	}
	cur := docRoot(root)
	if cur == nil {
		return 0, false
	}
	for _, seg := range segs {
		cur = descend(cur, seg)
		if cur == nil {
			return 0, false
		}
	}
	if cur.Line <= 0 {
		return 0, false
	}
	return cur.Line, true
}

func setTree(doc []byte, path string, value any, format string) (string, error) {
	return editTree(doc, path, value, false, format)
}

func removeTree(doc []byte, path, format string) (string, error) {
	return editTree(doc, path, nil, true, format)
}

func editTree(doc []byte, path string, value any, remove bool, format string) (string, error) {
	// A path carrying a document selector ("[1]$.spec.port") edits one document
	// inside a multi-document YAML stream: decode all documents, mutate the
	// addressed one, and re-emit the whole stream so the untouched documents
	// (and every comment) survive byte-for-byte. JSON files are never
	// multi-document, so this applies to YAML only.
	if idx, rest, multi := DocIndex(path); multi && format != "json" {
		return editMultiDoc(doc, idx, rest, value, remove)
	}
	segs, err := ParsePath(path)
	if err != nil {
		return "", err
	}
	var root yaml.Node
	if len(doc) > 0 {
		if err := yaml.Unmarshal(doc, &root); err != nil {
			return "", err
		}
	}
	top := ensureDocRoot(&root)

	if remove {
		removeAt(top, segs)
	} else {
		valNode := &yaml.Node{}
		if err := valNode.Encode(value); err != nil {
			return "", err
		}
		if err := setAt(top, segs, valNode); err != nil {
			return "", err
		}
	}

	if format == "json" {
		var b strings.Builder
		if err := emitJSON(&b, top, 0); err != nil {
			return "", err
		}
		b.WriteString("\n")
		return b.String(), nil
	}
	var b strings.Builder
	enc := yaml.NewEncoder(&b)
	enc.SetIndent(detectIndent(doc))
	if err := enc.Encode(&root); err != nil {
		return "", err
	}
	if err := enc.Close(); err != nil {
		return "", err
	}
	return b.String(), nil
}

// editMultiDoc applies one path edit to the idx-th document of a YAML stream
// and re-emits the whole stream. The rest path has already had its document
// selector stripped.
func editMultiDoc(doc []byte, idx int, rest string, value any, remove bool) (string, error) {
	segs, err := ParsePath(rest)
	if err != nil {
		return "", err
	}
	docs, err := decodeDocs(doc)
	if err != nil {
		return "", err
	}
	if idx >= len(docs) {
		return "", fmt.Errorf("document index %d out of range (stream has %d)", idx, len(docs))
	}
	top := ensureDocRoot(docs[idx])
	if remove {
		removeAt(top, segs)
	} else {
		valNode := &yaml.Node{}
		if err := valNode.Encode(value); err != nil {
			return "", err
		}
		if err := setAt(top, segs, valNode); err != nil {
			return "", err
		}
	}
	return encodeDocs(docs, detectIndent(doc))
}

// EditDoc parses a YAML document, hands the root mapping node to fn for a
// surgical structural mutation (beyond what a single path edit expresses),
// and re-encodes with the document's own indentation. It is the same
// comment- and style-preserving round trip Set/Remove use; writer reaches
// for it when editing .configer registry entries, so a one-field change
// stays a one-line diff even in hand-formatted files.
func EditDoc(doc []byte, fn func(root *yaml.Node) error) (string, error) {
	var root yaml.Node
	if len(doc) > 0 {
		if err := yaml.Unmarshal(doc, &root); err != nil {
			return "", err
		}
	}
	top := ensureDocRoot(&root)
	if err := fn(top); err != nil {
		return "", err
	}
	var b strings.Builder
	enc := yaml.NewEncoder(&b)
	enc.SetIndent(detectIndent(doc))
	if err := enc.Encode(&root); err != nil {
		return "", err
	}
	if err := enc.Close(); err != nil {
		return "", err
	}
	return b.String(), nil
}

// detectIndent reads the document's own indentation step (first indented line)
// so re-serialization matches the file's existing style; 2 when the document
// gives no signal.
func detectIndent(doc []byte) int {
	for _, line := range strings.Split(string(doc), "\n") {
		trimmed := strings.TrimLeft(line, " ")
		if trimmed == "" || trimmed == line || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if n := len(line) - len(trimmed); n >= 2 && n <= 8 {
			return n
		}
	}
	return 2
}

// docRoot returns the document's top-level node, or nil for an empty doc.
func docRoot(doc *yaml.Node) *yaml.Node {
	if doc.Kind == yaml.DocumentNode && len(doc.Content) > 0 {
		return doc.Content[0]
	}
	if doc.Kind != 0 {
		return doc
	}
	return nil
}

// ensureDocRoot returns the mapping node at the document root, initializing an
// empty document (new file) with an empty mapping.
func ensureDocRoot(doc *yaml.Node) *yaml.Node {
	if doc.Kind == 0 {
		doc.Kind = yaml.DocumentNode
	}
	if len(doc.Content) == 0 {
		doc.Content = []*yaml.Node{{Kind: yaml.MappingNode}}
	}
	if doc.Content[0].Kind == 0 {
		doc.Content[0].Kind = yaml.MappingNode
	}
	return doc.Content[0]
}

// descend takes one path step from cur, returning nil when the step does not
// resolve. Read-only: never mutates the tree.
func descend(cur *yaml.Node, seg Seg) *yaml.Node {
	cur = resolveAlias(cur)
	if seg.Key != "" {
		cur = mapValue(cur, seg.Key)
		if cur == nil {
			return nil
		}
		cur = resolveAlias(cur)
	}
	if seg.Index >= 0 {
		if cur.Kind != yaml.SequenceNode || seg.Index >= len(cur.Content) {
			return nil
		}
		cur = cur.Content[seg.Index]
	}
	if seg.SelKey != "" {
		cur = selectMatch(cur, seg.SelKey, seg.SelVal)
	}
	return cur
}

// resolveAlias follows an alias node to its anchor target.
func resolveAlias(n *yaml.Node) *yaml.Node {
	if n != nil && n.Kind == yaml.AliasNode && n.Alias != nil {
		return n.Alias
	}
	return n
}

// mapValue returns the value node for key in mapping m, or nil.
func mapValue(m *yaml.Node, key string) *yaml.Node {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

// selectMatch returns the sequence element (a mapping) whose selKey scalar
// equals selVal, or nil.
func selectMatch(seq *yaml.Node, selKey, selVal string) *yaml.Node {
	if seq == nil || seq.Kind != yaml.SequenceNode {
		return nil
	}
	for _, el := range seq.Content {
		if v := mapValue(resolveAlias(el), selKey); v != nil && v.Value == selVal {
			return el
		}
	}
	return nil
}

// setAt writes val at the segment path, creating intermediate mappings and
// sequence slots as needed. Only an append (index == len) can grow a sequence;
// a larger index is an error rather than padding with nulls.
func setAt(root *yaml.Node, segs []Seg, val *yaml.Node) error {
	cur := root
	for i, seg := range segs {
		last := i == len(segs)-1

		if seg.Key != "" {
			if seg.Index < 0 && seg.SelKey == "" {
				// plain key step
				if last {
					setChild(cur, seg.Key, val)
					return nil
				}
				next := segs[i+1]
				wantSeq := next.Key == "" // a bare [n]/[k=v] follows on the same node
				cur = childContainer(cur, seg.Key, wantSeq)
				continue
			}
			// key + bracket on one segment: descend into the sequence under key
			cur = childContainer(cur, seg.Key, true)
		}

		if cur.Kind != yaml.SequenceNode && seg.Key == "" {
			return fmt.Errorf("path indexes into a non-sequence node")
		}

		if seg.Index >= 0 {
			switch {
			case seg.Index < len(cur.Content):
				if last {
					preserveComments(cur.Content[seg.Index], val)
					cur.Content[seg.Index] = val
					return nil
				}
				cur = resolveAlias(cur.Content[seg.Index])
			case seg.Index == len(cur.Content):
				if last {
					cur.Content = append(cur.Content, val)
					return nil
				}
				next := &yaml.Node{Kind: yaml.MappingNode}
				cur.Content = append(cur.Content, next)
				cur = next
			default:
				return fmt.Errorf("index %d out of range (len %d)", seg.Index, len(cur.Content))
			}
			continue
		}

		if seg.SelKey != "" {
			el := selectMatch(cur, seg.SelKey, seg.SelVal)
			if el == nil {
				return fmt.Errorf("no element matches [%s=%s]", seg.SelKey, seg.SelVal)
			}
			if last {
				return fmt.Errorf("cannot replace a whole [%s=%s] element; set one of its keys", seg.SelKey, seg.SelVal)
			}
			cur = resolveAlias(el)
			continue
		}
	}
	return nil
}

// childContainer finds (or creates) the container value for key. A value of
// the wrong kind is replaced so the path can continue.
func childContainer(m *yaml.Node, key string, wantSeq bool) *yaml.Node {
	kind := yaml.MappingNode
	if wantSeq {
		kind = yaml.SequenceNode
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			v := resolveAlias(m.Content[i+1])
			if v.Kind != kind {
				nv := &yaml.Node{Kind: kind}
				m.Content[i+1] = nv
				return nv
			}
			return v
		}
	}
	k := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
	v := &yaml.Node{Kind: kind}
	m.Content = append(m.Content, k, v)
	return v
}

// setChild sets key to val in mapping m, replacing an existing value (and
// carrying over its comments for a minimal diff) or appending a new pair.
func setChild(m *yaml.Node, key string, val *yaml.Node) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			preserveComments(m.Content[i+1], val)
			m.Content[i+1] = val
			return
		}
	}
	k := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
	m.Content = append(m.Content, k, val)
}

func preserveComments(old, val *yaml.Node) {
	val.HeadComment = old.HeadComment
	val.LineComment = old.LineComment
	val.FootComment = old.FootComment
}

// removeAt deletes the node at the segment path and prunes now-empty parent
// containers bottom-up, so absence leaves no dangling empty section behind.
// A path that does not resolve is a no-op.
func removeAt(root *yaml.Node, segs []Seg) {
	type step struct {
		node *yaml.Node // container the removal happens in
		seg  Seg
	}
	var chain []step
	cur := root
	for i, seg := range segs {
		last := i == len(segs)-1

		container := cur
		if seg.Key != "" {
			if seg.Index < 0 && seg.SelKey == "" {
				if last {
					if !removeChild(container, seg.Key) {
						return
					}
					chain = append(chain, step{container, seg})
					break
				}
				next := mapValue(container, seg.Key)
				if next == nil {
					return
				}
				chain = append(chain, step{container, seg})
				cur = resolveAlias(next)
				continue
			}
			seqNode := mapValue(container, seg.Key)
			if seqNode = resolveAlias(seqNode); seqNode == nil || seqNode.Kind != yaml.SequenceNode {
				return
			}
			chain = append(chain, step{container, Seg{Key: seg.Key, Index: -1}})
			container = seqNode
		}

		idx := seg.Index
		if seg.SelKey != "" {
			idx = -1
			for j, el := range container.Content {
				if v := mapValue(resolveAlias(el), seg.SelKey); v != nil && v.Value == seg.SelVal {
					idx = j
					break
				}
			}
		}
		if idx < 0 || container.Kind != yaml.SequenceNode || idx >= len(container.Content) {
			return
		}
		if last {
			container.Content = append(container.Content[:idx], container.Content[idx+1:]...)
			break
		}
		cur = resolveAlias(container.Content[idx])
	}

	// prune empty parents bottom-up (the terminal was already removed; a
	// container the removal emptied is itself removed, and so on upward)
	for i := len(chain) - 1; i >= 0; i-- {
		child := resolveAlias(mapValue(chain[i].node, chain[i].seg.Key))
		if child != nil && len(child.Content) == 0 {
			removeChild(chain[i].node, chain[i].seg.Key)
		}
	}
}

// removeChild deletes key from mapping m, reporting whether it was present.
func removeChild(m *yaml.Node, key string) bool {
	if m.Kind != yaml.MappingNode {
		return false
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			m.Content = append(m.Content[:i], m.Content[i+2:]...)
			return true
		}
	}
	return false
}

// --- JSON emission -----------------------------------------------------------

// emitJSON serializes a yaml.Node tree as pretty-printed JSON, preserving the
// tree's key order. Scalars are typed by their YAML tag.
func emitJSON(b *strings.Builder, n *yaml.Node, depth int) error {
	n = resolveAlias(n)
	if n == nil {
		b.WriteString("null")
		return nil
	}
	indent := strings.Repeat("  ", depth)
	child := strings.Repeat("  ", depth+1)

	switch n.Kind {
	case yaml.MappingNode:
		if len(n.Content) == 0 {
			b.WriteString("{}")
			return nil
		}
		b.WriteString("{\n")
		for i := 0; i+1 < len(n.Content); i += 2 {
			if i > 0 {
				b.WriteString(",\n")
			}
			key, err := json.Marshal(n.Content[i].Value)
			if err != nil {
				return err
			}
			b.WriteString(child)
			b.Write(key)
			b.WriteString(": ")
			if err := emitJSON(b, n.Content[i+1], depth+1); err != nil {
				return err
			}
		}
		b.WriteString("\n" + indent + "}")
	case yaml.SequenceNode:
		if len(n.Content) == 0 {
			b.WriteString("[]")
			return nil
		}
		b.WriteString("[\n")
		for i, el := range n.Content {
			if i > 0 {
				b.WriteString(",\n")
			}
			b.WriteString(child)
			if err := emitJSON(b, el, depth+1); err != nil {
				return err
			}
		}
		b.WriteString("\n" + indent + "]")
	case yaml.ScalarNode:
		return emitJSONScalar(b, n)
	default:
		b.WriteString("null")
	}
	return nil
}

func emitJSONScalar(b *strings.Builder, n *yaml.Node) error {
	switch n.Tag {
	case "!!null":
		b.WriteString("null")
	case "!!bool", "!!int", "!!float":
		var v any
		if err := n.Decode(&v); err != nil {
			return err
		}
		enc, err := json.Marshal(v)
		if err != nil {
			return err
		}
		b.Write(enc)
	default:
		enc, err := json.Marshal(n.Value)
		if err != nil {
			return err
		}
		b.Write(enc)
	}
	return nil
}
