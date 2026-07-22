package pathedit

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/beevik/etree"
)

// XML paths are XPath-like: /root/section/leaf addresses element text,
// /root/section/@attr an attribute. A list parameter maps to repeated sibling
// elements at its path - one element per entry, so cardinality follows the
// value's length.

func getXML(doc []byte, path string) (any, bool, error) {
	if len(doc) == 0 {
		return nil, false, nil
	}
	d := etree.NewDocument()
	if err := d.ReadFromBytes(doc); err != nil {
		return nil, false, err
	}
	return getXMLFromDoc(d, path)
}

// getXMLFromDoc reads path from an already-parsed etree document (cached-doc
// path). Read-only.
func getXMLFromDoc(d *etree.Document, path string) (any, bool, error) {
	if attr, elemPath, isAttr := splitAttrPath(path); isAttr {
		el := findXML(d, elemPath)
		if el == nil {
			return nil, false, nil
		}
		if a := el.SelectAttr(attr); a != nil {
			return a.Value, true, nil
		}
		return nil, false, nil
	}
	el := findXML(d, path)
	if el == nil {
		return nil, false, nil
	}
	// Repeated siblings read back as a list.
	if parent := el.Parent(); parent != nil {
		if siblings := parent.SelectElements(el.Tag); len(siblings) > 1 {
			items := make([]any, 0, len(siblings))
			for _, s := range siblings {
				items = append(items, s.Text())
			}
			return items, true, nil
		}
	}
	return el.Text(), true, nil
}

func editXML(doc []byte, path string, ptype model.ParamType, value any, remove bool) (string, error) {
	// Surgical fast path: setting a single scalar value (an attribute or a leaf
	// element's text) is spliced straight into the original bytes, so every
	// unrelated line - comments, blank lines, multi-line attribute layouts,
	// namespace declarations - survives untouched. Only structural edits (lists,
	// removals, creating a node that does not exist) fall through to etree, which
	// necessarily re-serializes and thus reflows the document.
	if ptype != model.TypeList && !remove && len(doc) > 0 {
		if out, ok := editXMLInPlace(doc, path, scalarString(value)); ok {
			return out, nil
		}
	}

	d := etree.NewDocument()
	if len(doc) > 0 {
		if err := d.ReadFromBytes(doc); err != nil {
			return "", err
		}
	}

	if ptype == model.TypeList {
		applyXMLList(d, path, value, remove)
	} else if attr, elemPath, isAttr := splitAttrPath(path); isAttr {
		el := findXML(d, elemPath)
		if remove {
			if el != nil {
				el.RemoveAttr(attr)
			}
		} else {
			if el == nil {
				el = ensureXML(d, elemPath)
			}
			el.CreateAttr(attr, scalarString(value))
		}
	} else {
		el := findXML(d, path)
		if remove {
			if el != nil && el.Parent() != nil {
				parent := el.Parent()
				parent.RemoveChild(el)
				pruneEmptyXML(parent)
			}
		} else {
			if el == nil {
				el = ensureXML(d, path)
			}
			el.SetText(scalarString(value))
		}
	}

	// A structural edit re-serializes the whole tree; match the source's own
	// indentation so the reflow at least stays in the file's own style.
	if n, tabs, ok := detectXMLIndent(doc); ok && tabs {
		d.IndentTabs()
	} else if ok {
		d.Indent(n)
	} else {
		d.Indent(2)
	}
	return d.WriteToString()
}

// editXMLInPlace sets one scalar (attribute value or leaf element text) by
// splicing into the original bytes and returns ok=false when it cannot do so
// surgically (the node does not exist yet, the element is not a simple leaf, or
// the value could not be located) so the caller can fall back to etree.
func editXMLInPlace(doc []byte, path, newVal string) (string, bool) {
	attr, elemPath, isAttr := splitAttrPath(path)
	target := path
	if isAttr {
		target = elemPath
	}
	raw := xmlSegments(target)
	if len(raw) == 0 {
		return "", false
	}
	type seg struct {
		tag string
		idx int
	}
	segs := make([]seg, len(raw))
	for i, s := range raw {
		tag, idx := localTag(s)
		segs[i] = seg{tag: tag, idx: idx}
	}

	dec := xml.NewDecoder(bytes.NewReader(doc))
	dec.Strict = false
	var stack []string
	counts := []map[string]int{{}}
	matchDepth := 0
	for {
		startOff := dec.InputOffset()
		tok, err := dec.Token()
		if err != nil {
			return "", false
		}
		switch t := tok.(type) {
		case xml.StartElement:
			name := t.Name.Local
			parent := counts[len(counts)-1]
			parent[name]++
			occ := parent[name]
			depth := len(stack)
			matched := depth == matchDepth && matchDepth < len(segs) &&
				segs[matchDepth].tag == name &&
				(segs[matchDepth].idx == 0 || segs[matchDepth].idx == occ)
			if matched {
				matchDepth++
				if matchDepth == len(segs) {
					endTag := dec.InputOffset() // just past '>' of this start tag
					if isAttr {
						return spliceAttrValue(doc, startOff, endTag, t, attr, newVal)
					}
					return spliceElementText(doc, dec, endTag, newVal)
				}
			}
			stack = append(stack, name)
			counts = append(counts, map[string]int{})
		case xml.EndElement:
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
				counts = counts[:len(counts)-1]
				if matchDepth > len(stack) {
					matchDepth = len(stack)
				}
			}
		}
	}
}

// spliceAttrValue rewrites just the quoted value of `attr` inside the start-tag
// byte span [tagStart,tagEnd), leaving the rest of the tag (and document) intact.
func spliceAttrValue(doc []byte, tagStart, tagEnd int64, el xml.StartElement, attr, newVal string) (string, bool) {
	var oldVal string
	found := false
	for _, a := range el.Attr {
		if a.Name.Local == attr {
			oldVal, found = a.Value, true
			break
		}
	}
	if !found {
		return "", false // attribute absent: let etree create it
	}
	tag := doc[tagStart:tagEnd]
	re := regexp.MustCompile(`(?:^|\s)(?:[A-Za-z_][\w.\-]*:)?` + regexp.QuoteMeta(attr) + `\s*=\s*`)
	for _, loc := range re.FindAllIndex(tag, -1) {
		p := loc[1]
		if p >= len(tag) {
			continue
		}
		q := tag[p]
		if q != '"' && q != '\'' {
			continue
		}
		rel := bytes.IndexByte(tag[p+1:], q)
		if rel < 0 {
			continue
		}
		vs, ve := p+1, p+1+rel
		if xmlUnescape(string(tag[vs:ve])) != oldVal {
			continue // a different attribute of the same local name; keep looking
		}
		var b bytes.Buffer
		b.Write(doc[:tagStart])
		b.Write(tag[:vs])
		b.WriteString(xmlEscapeAttr(newVal, q))
		b.Write(tag[ve:])
		b.Write(doc[tagEnd:])
		return b.String(), true
	}
	return "", false
}

// spliceElementText rewrites the text of a leaf element that starts at textStart
// (the byte just past its start tag). It handles both a filled leaf
// (<x>old</x>) and an empty one (<x></x>); anything else (children, mixed
// content, self-closing) returns ok=false.
func spliceElementText(doc []byte, dec *xml.Decoder, textStart int64, newVal string) (string, bool) {
	tok, err := dec.Token()
	if err != nil {
		return "", false
	}
	switch tok.(type) {
	case xml.EndElement:
		// Empty element: insert the escaped text between the tags.
		var b bytes.Buffer
		b.Write(doc[:textStart])
		b.WriteString(xmlEscapeText(newVal))
		b.Write(doc[textStart:])
		return b.String(), true
	case xml.CharData:
		textEnd := dec.InputOffset()
		next, err := dec.Token()
		if err != nil {
			return "", false
		}
		if _, ok := next.(xml.EndElement); !ok {
			return "", false // mixed or nested content: not a simple leaf
		}
		body := doc[textStart:textEnd]
		lead := len(body) - len(bytes.TrimLeft(body, " \t\r\n"))
		trail := len(body) - len(bytes.TrimRight(body, " \t\r\n"))
		if lead+trail >= len(body) { // whitespace-only: treat as empty
			lead, trail = len(body), 0
		}
		var b bytes.Buffer
		b.Write(doc[:textStart])
		b.Write(body[:lead])
		b.WriteString(xmlEscapeText(newVal))
		b.Write(body[len(body)-trail:])
		b.Write(doc[textEnd:])
		return b.String(), true
	default:
		return "", false
	}
}

// detectXMLIndent sniffs the document's indentation unit from its first indented
// line, so a fall-through re-serialize keeps the file's own style.
func detectXMLIndent(doc []byte) (n int, tabs bool, ok bool) {
	for _, line := range bytes.Split(doc, []byte{'\n'}) {
		if len(line) == 0 || (line[0] != ' ' && line[0] != '\t') {
			continue
		}
		if line[0] == '\t' {
			return 1, true, true
		}
		w := len(line) - len(bytes.TrimLeft(line, " "))
		if w > 0 {
			return w, false, true
		}
	}
	return 0, false, false
}

var xmlEntityUnescape = strings.NewReplacer(
	"&lt;", "<", "&gt;", ">", "&quot;", `"`, "&apos;", "'", "&amp;", "&",
)

func xmlUnescape(s string) string { return xmlEntityUnescape.Replace(s) }

func xmlEscapeText(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

func xmlEscapeAttr(s string, quote byte) string {
	s = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
	if quote == '\'' {
		return strings.ReplaceAll(s, "'", "&apos;")
	}
	return strings.ReplaceAll(s, `"`, "&quot;")
}

// applyXMLList replaces every <tag> child at the path's parent with one
// element per list entry (or removes them all when the parameter is absent).
func applyXMLList(doc *etree.Document, path string, value any, remove bool) {
	segs := xmlSegments(path)
	if len(segs) == 0 {
		return
	}
	tag := segs[len(segs)-1]
	parentPath := "/" + strings.Join(segs[:len(segs)-1], "/")

	parent := findXML(doc, parentPath)
	if parent == nil {
		if remove {
			return
		}
		parent = ensureXML(doc, parentPath)
	}
	for _, child := range parent.SelectElements(tag) {
		parent.RemoveChild(child)
	}
	if remove {
		pruneEmptyXML(parent)
		return
	}
	items, _ := value.([]any)
	for _, it := range items {
		parent.CreateElement(tag).SetText(scalarString(it))
	}
	if len(items) == 0 {
		pruneEmptyXML(parent)
	}
}

// pruneEmptyXML removes now-empty elements bottom-up (never the root), so
// absence leaves no husk like <syslog/> behind.
func pruneEmptyXML(el *etree.Element) {
	for el != nil {
		parent := el.Parent()
		// parent == nil: detached; parent.Parent() == nil: el is the root
		// element (its parent is the document container); keep the root.
		if parent == nil || parent.Parent() == nil {
			return
		}
		if len(el.ChildElements()) > 0 || len(el.Attr) > 0 || strings.TrimSpace(el.Text()) != "" {
			return
		}
		parent.RemoveChild(el)
		el = parent
	}
}

// localTag strips a namespace prefix (rt:routing -> routing) and a positional
// predicate (interface[1] -> interface, 1). The 1-based index is 0 when the
// segment carries no predicate. The XML decoder reports local names without
// their prefix, so paths are matched on the local name across a document.
func localTag(seg string) (tag string, idx int) {
	tag = seg
	if j := strings.Index(tag, "["); j >= 0 {
		inner := strings.TrimSuffix(tag[j+1:], "]")
		if n, err := strconv.Atoi(strings.TrimSpace(inner)); err == nil {
			idx = n
		}
		tag = tag[:j]
	}
	if k := strings.LastIndex(tag, ":"); k >= 0 {
		tag = tag[k+1:]
	}
	return tag, idx
}

// xmlLine returns the 1-based source line of the element (or the element that
// owns the attribute) addressed by an XPath-like path. etree exposes no
// per-node line, so this re-parses with the standard XML decoder and tracks
// byte offsets, counting same-name siblings to honor [n] predicates. Best
// effort: an unresolved path returns ok=false and the caller opens at the top.
func xmlLine(doc []byte, path string) (int, bool) {
	elemPath := path
	if _, ep, isAttr := splitAttrPath(path); isAttr {
		elemPath = ep
	}
	raw := xmlSegments(elemPath)
	if len(raw) == 0 {
		return 0, false
	}
	type seg struct {
		tag string
		idx int // 1-based sibling index; 0 = first match wins
	}
	segs := make([]seg, len(raw))
	for i, s := range raw {
		tag, idx := localTag(s)
		segs[i] = seg{tag: tag, idx: idx}
	}

	dec := xml.NewDecoder(bytes.NewReader(doc))
	dec.Strict = false // locate is best-effort; never fail on odd real-world XML
	var stack []string             // open element local names
	counts := []map[string]int{{}} // per open parent: child local name -> count seen
	matchDepth := 0                // matched leading segments along the current open path
	for {
		off := dec.InputOffset() // start of the token about to be read
		tok, err := dec.Token()
		if err != nil {
			return 0, false
		}
		switch t := tok.(type) {
		case xml.StartElement:
			name := t.Name.Local
			parent := counts[len(counts)-1]
			parent[name]++
			occ := parent[name]
			depth := len(stack)
			// This element extends the target path only when every ancestor
			// already matched (depth == matchDepth), the local names agree, and
			// the predicate (if any) picks this sibling occurrence.
			if depth == matchDepth && matchDepth < len(segs) &&
				segs[matchDepth].tag == name &&
				(segs[matchDepth].idx == 0 || segs[matchDepth].idx == occ) {
				matchDepth++
				if matchDepth == len(segs) {
					return 1 + bytes.Count(doc[:off], []byte{'\n'}), true
				}
			}
			stack = append(stack, name)
			counts = append(counts, map[string]int{})
		case xml.EndElement:
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
				counts = counts[:len(counts)-1]
				if matchDepth > len(stack) {
					matchDepth = len(stack)
				}
			}
		}
	}
}

func splitAttrPath(path string) (attr, elemPath string, isAttr bool) {
	i := strings.LastIndex(path, "/@")
	if i < 0 {
		return "", "", false
	}
	return path[i+2:], path[:i], true
}

func xmlSegments(path string) []string {
	path = strings.Trim(path, "/")
	if path == "" {
		return nil
	}
	return strings.Split(path, "/")
}

// findXML locates an element, tolerating [n] index predicates from ingest.
func findXML(doc *etree.Document, path string) *etree.Element {
	if el := doc.FindElement(path); el != nil {
		return el
	}
	// strip predicates and walk first-matches
	var cur *etree.Element
	for i, seg := range xmlSegments(path) {
		tag := seg
		if j := strings.Index(tag, "["); j >= 0 {
			tag = tag[:j]
		}
		if i == 0 {
			root := doc.Root()
			if root == nil || root.Tag != tag {
				return nil
			}
			cur = root
			continue
		}
		cur = cur.SelectElement(tag)
		if cur == nil {
			return nil
		}
	}
	return cur
}

// ensureXML creates the element chain for path (predicates ignored).
func ensureXML(doc *etree.Document, path string) *etree.Element {
	segs := xmlSegments(path)
	var cur *etree.Element
	for i, seg := range segs {
		tag := seg
		if j := strings.Index(tag, "["); j >= 0 {
			tag = tag[:j]
		}
		if i == 0 {
			root := doc.Root()
			if root == nil {
				root = doc.CreateElement(tag)
			}
			cur = root
			continue
		}
		next := cur.SelectElement(tag)
		if next == nil {
			next = cur.CreateElement(tag)
		}
		cur = next
	}
	return cur
}

func scalarString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return fmt.Sprintf("%v", v)
	}
}
