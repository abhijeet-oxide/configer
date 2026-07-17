package pathedit

import (
	"fmt"
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

	d.Indent(2)
	return d.WriteToString()
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
