package pathedit

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// DuplicateEntry copies one entry of a repeated structure and returns the new
// document plus the path the copy now answers to.
//
// The copy is APPENDED after the last sibling of its kind, never inserted
// beside the entry it came from. Both spellings look the same in the file and
// only one of them is safe: these entries are addressed by position
// (`net-info[3]`, `servers[2]`), so inserting in the middle silently renumbers
// every entry below it and every binding pointing at them starts reading a
// different thing. Appending gives the copy the next index and moves nothing.
//
// XML is copied as BYTES - the element's own source text, indentation and
// comments included - so a hand-maintained document keeps its shape and the
// review diff is the new block and nothing else. YAML and JSON go through the
// node tree, which is the same road every structural edit in this package
// takes.
func DuplicateEntry(doc []byte, format, path string) (out string, newPath string, err error) {
	if len(bytes.TrimSpace(doc)) == 0 {
		return "", "", fmt.Errorf("the file is empty, so there is no entry to duplicate")
	}
	if se := CheckSyntax(doc, format); se != nil {
		return "", "", fmt.Errorf("the file does not parse (%s), so nothing can be copied from it", se.Error())
	}
	if normFormat(format) == "xml" {
		return duplicateXMLEntry(doc, path)
	}
	return duplicateTreeEntry(doc, format, path)
}

// --- XML ------------------------------------------------------------------

// xmlSpan is one element's byte range in the source, [start,end).
type xmlSpan struct{ start, end int }

func duplicateXMLEntry(doc []byte, path string) (string, string, error) {
	if _, _, isAttr := splitAttrPath(path); isAttr {
		return "", "", fmt.Errorf("an attribute is not a repeatable entry")
	}
	segs := xmlSegments(path)
	if len(segs) < 2 {
		return "", "", fmt.Errorf("the document root cannot be duplicated")
	}
	tag, idx := localTag(segs[len(segs)-1])
	if idx == 0 {
		idx = 1
	}
	spans, err := xmlSiblingSpans(doc, segs)
	if err != nil {
		return "", "", err
	}
	if idx > len(spans) {
		return "", "", fmt.Errorf("there is no %s entry %d in this file", tag, idx)
	}
	src, last := spans[idx-1], spans[len(spans)-1]
	block := string(doc[src.start:src.end])

	// The copy lands on its own line, indented the way its source is. Reading
	// the indentation off the SOURCE (not the file) is what keeps a deeply
	// nested entry from arriving flat against the margin.
	indent := lineIndentBefore(doc, src.start)
	insert := "\n" + indent + block
	var b strings.Builder
	b.Grow(len(doc) + len(insert))
	b.Write(doc[:last.end])
	b.WriteString(insert)
	b.Write(doc[last.end:])

	parent := strings.Join(segs[:len(segs)-1], "/")
	newPath := "/" + parent + "/" + tag + "[" + strconv.Itoa(len(spans)+1) + "]"
	return b.String(), newPath, nil
}

// xmlSiblingSpans returns the byte ranges of every element that shares the
// path's last tag under the same parent, in document order.
func xmlSiblingSpans(doc []byte, segs []string) ([]xmlSpan, error) {
	parent := make([]struct {
		tag string
		idx int
	}, len(segs)-1)
	for i := 0; i < len(segs)-1; i++ {
		parent[i].tag, parent[i].idx = localTag(segs[i])
	}
	wantTag, _ := localTag(segs[len(segs)-1])

	dec := xml.NewDecoder(bytes.NewReader(doc))
	dec.Strict = false
	var (
		spans      []xmlSpan
		stack      []string
		counts     = []map[string]int{{}}
		matchDepth int
		// open tracks the element currently being captured: its start offset and
		// the stack depth it opened at, so the matching close is the one that
		// ends it (an entry may nest another element of the same name).
		openStart = -1
		openDepth = -1
	)
	for {
		startOff := int(dec.InputOffset())
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			name := t.Name.Local
			c := counts[len(counts)-1]
			c[name]++
			occ := c[name]
			depth := len(stack)
			if openStart < 0 && depth == len(parent) && matchDepth == len(parent) && name == wantTag {
				openStart, openDepth = startOff, depth
			} else if openStart < 0 && depth == matchDepth && matchDepth < len(parent) &&
				parent[matchDepth].tag == name &&
				(parent[matchDepth].idx == 0 || parent[matchDepth].idx == occ) {
				matchDepth++
			}
			stack = append(stack, name)
			counts = append(counts, map[string]int{})
			// A self-closing element is reported as a start immediately followed
			// by an end, so nothing special is needed here.
		case xml.EndElement:
			if len(stack) == 0 {
				continue
			}
			stack = stack[:len(stack)-1]
			counts = counts[:len(counts)-1]
			if openStart >= 0 && len(stack) == openDepth {
				spans = append(spans, xmlSpan{openStart, int(dec.InputOffset())})
				openStart, openDepth = -1, -1
			}
			if matchDepth > len(stack) {
				matchDepth = len(stack)
			}
		}
	}
	if len(spans) == 0 {
		return nil, fmt.Errorf("no <%s> entry found at that place in the file", wantTag)
	}
	return spans, nil
}

// lineIndentBefore returns the whitespace between the start of the line and
// offset, or "" when anything else shares the line.
func lineIndentBefore(doc []byte, offset int) string {
	i := bytes.LastIndexByte(doc[:offset], '\n')
	head := doc[i+1 : offset]
	if strings.TrimSpace(string(head)) != "" {
		return ""
	}
	return string(head)
}

// --- YAML / JSON ----------------------------------------------------------

func duplicateTreeEntry(doc []byte, format, path string) (string, string, error) {
	segs, err := ParsePath(path)
	if err != nil {
		return "", "", err
	}
	last := segs[len(segs)-1]
	if last.SelKey != "" {
		return "", "", fmt.Errorf(
			"this entry is identified by %s=%s, so a copy would be a second entry with the same %s; "+
				"add the new one in file mode and give it its own %s",
			last.SelKey, last.SelVal, last.SelKey, last.SelKey)
	}
	if last.Index < 0 {
		return "", "", fmt.Errorf("only an entry of a list can be duplicated")
	}

	// The same parse / mutate / re-emit round trip every structural edit in this
	// package takes, so a duplicated entry lands in the file's own indentation
	// and its blank lines survive.
	var root yaml.Node
	if err := yaml.Unmarshal(doc, &root); err != nil {
		return "", "", err
	}
	top := ensureDocRoot(&root, rootKind(segs))
	seq, err := resolveSequence(top, segs)
	if err != nil {
		return "", "", err
	}
	if last.Index >= len(seq.Content) {
		return "", "", fmt.Errorf("there is no entry %d in that list", last.Index)
	}
	seq.Content = append(seq.Content, deepCopyNode(seq.Content[last.Index]))
	newIndex := len(seq.Content) - 1

	var b strings.Builder
	if normFormat(format) == "json" {
		if err := emitJSON(&b, top, 0, strings.Repeat(" ", detectIndent(doc))); err != nil {
			return "", "", err
		}
		b.WriteString("\n")
		return b.String(), indexedPath(path, newIndex), nil
	}
	enc := yaml.NewEncoder(&b)
	enc.SetIndent(detectIndent(doc))
	if err := enc.Encode(&root); err != nil {
		return "", "", err
	}
	if err := enc.Close(); err != nil {
		return "", "", err
	}
	return reflowBlanks(string(doc), b.String()), indexedPath(path, newIndex), nil
}

// indexedPath rewrites a path's trailing subscript to a new index.
func indexedPath(path string, index int) string {
	i := strings.LastIndex(path, "[")
	if i < 0 {
		return path
	}
	return fmt.Sprintf("%s[%d]", path[:i], index)
}

// resolveSequence walks to the sequence node the path's final index addresses.
func resolveSequence(top *yaml.Node, segs []Seg) (*yaml.Node, error) {
	cur := top
	for i, s := range segs {
		lastSeg := i == len(segs)-1
		if s.Key != "" || s.Quoted {
			if cur.Kind != yaml.MappingNode {
				return nil, fmt.Errorf("%q is not a section of this file", s.Key)
			}
			found := false
			for j := 0; j+1 < len(cur.Content); j += 2 {
				if cur.Content[j].Value == s.Key {
					cur = cur.Content[j+1]
					found = true
					break
				}
			}
			if !found {
				return nil, fmt.Errorf("%q is not in this file", s.Key)
			}
		}
		if s.Index < 0 {
			continue
		}
		if cur.Kind != yaml.SequenceNode {
			return nil, fmt.Errorf("that place in the file is not a list")
		}
		if lastSeg {
			return cur, nil
		}
		if s.Index >= len(cur.Content) {
			return nil, fmt.Errorf("there is no entry %d in that list", s.Index)
		}
		cur = cur.Content[s.Index]
	}
	return nil, fmt.Errorf("that path does not end in a list entry")
}

// deepCopyNode clones a yaml.Node tree, dropping the source positions so the
// copy is emitted fresh rather than claiming the original's lines. Comments
// travel with it: they are part of the entry a person asked to duplicate.
func deepCopyNode(n *yaml.Node) *yaml.Node {
	if n == nil {
		return nil
	}
	out := *n
	out.Line, out.Column = 0, 0
	// An anchor may only be defined once in a document; a copy carrying the
	// original's anchor makes the file invalid.
	out.Anchor = ""
	out.Content = make([]*yaml.Node, len(n.Content))
	for i, c := range n.Content {
		out.Content[i] = deepCopyNode(c)
	}
	return &out
}
