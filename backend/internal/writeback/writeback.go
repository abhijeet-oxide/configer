// Package writeback edits configuration values directly in the repository's own
// files — the write-back-native model where the real files remain the source of
// truth and Configer's .configure/ folder holds only metadata and mappings
// (see docs/VISION.md). Given (file, format, path, value) it reads the target
// file, sets or removes the value at the mapped location, and writes it back.
//
// For YAML the edit is surgical: the node tree is navigated and only the mapped
// key is changed, so comments, key order and every unmanaged line are preserved
// and the resulting Git diff is minimal. JSON and XML reuse the shared
// render.ApplyOne engine (JSON carries no comments; etree preserves XML
// structure).
package writeback

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/render"
	"gopkg.in/yaml.v3"
)

// SetValue writes value at path inside root/file, creating the file and any
// intermediate structure as needed.
func SetValue(root, file, format, path string, ptype model.ParamType, value any) error {
	return apply(root, file, format, path, ptype, value, false)
}

// RemoveValue removes the value at path inside root/file, pruning now-empty
// parents so no dangling empty section is left behind.
func RemoveValue(root, file, format, path string, ptype model.ParamType) error {
	return apply(root, file, format, path, ptype, nil, true)
}

func apply(root, file, format, path string, ptype model.ParamType, value any, remove bool) error {
	full := filepath.Join(root, file)
	base, err := os.ReadFile(full)
	if err != nil && !os.IsNotExist(err) {
		return err
	}

	var out string
	// Plain dotted YAML paths get the comment-preserving surgical edit; anything
	// with an index predicate, or JSON/XML, goes through the shared engine.
	if (format == "" || format == "yaml" || format == "yml") && !strings.ContainsAny(path, "[]/@") {
		out, err = yamlSurgical(base, path, value, remove)
	} else {
		out, err = render.ApplyOne(base, format, path, ptype, value, remove)
	}
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	return os.WriteFile(full, []byte(out), 0o644)
}

// yamlSurgical edits a YAML document's node tree in place, touching only the
// mapped key and leaving all other content (comments, order, unmanaged keys)
// byte-for-byte where it was.
func yamlSurgical(base []byte, path string, value any, remove bool) (string, error) {
	var doc yaml.Node
	if len(base) > 0 {
		if err := yaml.Unmarshal(base, &doc); err != nil {
			return "", err
		}
	}
	rootMap := ensureDocRoot(&doc)

	segs := segments(path)
	if len(segs) == 0 {
		return "", fmt.Errorf("empty path")
	}

	if remove {
		removeAt(rootMap, segs)
	} else {
		valNode := &yaml.Node{}
		if err := valNode.Encode(value); err != nil {
			return "", err
		}
		setAtNode(rootMap, segs, valNode)
	}

	b, err := yaml.Marshal(&doc)
	return string(b), err
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

func setAtNode(m *yaml.Node, segs []string, val *yaml.Node) {
	cur := m
	for i, seg := range segs {
		if i == len(segs)-1 {
			setChild(cur, seg, val)
			return
		}
		cur = childMap(cur, seg)
	}
}

// childMap finds (or creates) the mapping value for key. If the key exists but
// is not a mapping, it is replaced by an empty mapping so the path can continue.
func childMap(m *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			if m.Content[i+1].Kind != yaml.MappingNode {
				nv := &yaml.Node{Kind: yaml.MappingNode}
				m.Content[i+1] = nv
				return nv
			}
			return m.Content[i+1]
		}
	}
	k := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
	v := &yaml.Node{Kind: yaml.MappingNode}
	m.Content = append(m.Content, k, v)
	return v
}

// setChild sets key to val in mapping m, replacing an existing value (and
// carrying over its comments for a minimal diff) or appending a new pair.
func setChild(m *yaml.Node, key string, val *yaml.Node) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			val.HeadComment = m.Content[i+1].HeadComment
			val.LineComment = m.Content[i+1].LineComment
			val.FootComment = m.Content[i+1].FootComment
			m.Content[i+1] = val
			return
		}
	}
	k := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
	m.Content = append(m.Content, k, val)
}

func removeAt(m *yaml.Node, segs []string) {
	type step struct {
		node *yaml.Node
		key  string
	}
	cur := m
	chain := make([]step, 0, len(segs))
	for i, seg := range segs {
		if i == len(segs)-1 {
			chain = append(chain, step{cur, seg})
			removeChild(cur, seg)
			break
		}
		next := findChildMap(cur, seg)
		if next == nil {
			return // path not present: nothing to remove
		}
		chain = append(chain, step{cur, seg})
		cur = next
	}
	// prune now-empty parents bottom-up (the terminal was already removed)
	for i := len(chain) - 2; i >= 0; i-- {
		child := findChildMap(chain[i].node, chain[i].key)
		if child != nil && len(child.Content) == 0 {
			removeChild(chain[i].node, chain[i].key)
		}
	}
}

func findChildMap(m *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key && m.Content[i+1].Kind == yaml.MappingNode {
			return m.Content[i+1]
		}
	}
	return nil
}

func removeChild(m *yaml.Node, key string) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			m.Content = append(m.Content[:i], m.Content[i+2:]...)
			return
		}
	}
}

// segments turns "$.a.b.c" (or "a.b.c") into ["a","b","c"].
func segments(path string) []string {
	s := strings.TrimPrefix(path, "$.")
	s = strings.TrimPrefix(s, "$")
	s = strings.TrimPrefix(s, ".")
	if s == "" {
		return nil
	}
	return strings.Split(s, ".")
}
