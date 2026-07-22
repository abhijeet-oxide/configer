package pathedit

import (
	"fmt"
	"strconv"
	"strings"
)

// Seg is one step of a parsed YAML/JSON path. A step addresses a mapping key
// and optionally descends into a sequence: by position (Index >= 0) or by a
// [key=value] selector matching a mapping element.
type Seg struct {
	Key    string // mapping key; empty for a bare index on the current node
	Index  int    // sequence position, -1 when absent
	SelKey string // selector key for [k=v], empty when absent
	SelVal string // selector value for [k=v]
}

// DocIndex splits an optional leading document selector from a YAML/JSON path.
// A single file may hold several YAML documents separated by "---" (the
// Kubernetes norm); a path targets the Nth document with a leading "[N]" before
// the "$" (e.g. "[1]$.spec.port"). It returns the 0-based document index (0
// when no selector is present), the remaining path, and whether a selector was
// found. This is the ONE place the multi-document path syntax is defined, so
// the parser, discovery and the edit engine all agree on it.
func DocIndex(path string) (idx int, rest string, ok bool) {
	if len(path) < 2 || path[0] != '[' {
		return 0, path, false
	}
	end := strings.IndexByte(path, ']')
	if end < 2 {
		return 0, path, false
	}
	n, err := strconv.Atoi(path[1:end])
	if err != nil || n < 0 {
		return 0, path, false
	}
	return n, path[end+1:], true
}

// ParsePath turns a dotted path ("$.a.b", "servers[2]", "rules[name=ssh].port")
// into segments. The leading "$." / "$" is optional. A leading document
// selector ("[N]$…") is stripped first. XML paths use XPath and are not parsed
// here.
func ParsePath(path string) ([]Seg, error) {
	if _, rest, ok := DocIndex(path); ok {
		path = rest
	}
	s := strings.TrimPrefix(path, "$.")
	s = strings.TrimPrefix(s, "$")
	s = strings.TrimPrefix(s, ".")
	if s == "" {
		return nil, fmt.Errorf("empty path")
	}

	var segs []Seg
	for _, part := range splitDots(s) {
		key := part
		var brackets []string
		for {
			i := strings.Index(key, "[")
			if i < 0 {
				break
			}
			j := strings.Index(key[i:], "]")
			if j < 0 {
				return nil, fmt.Errorf("unclosed '[' in path segment %q", part)
			}
			brackets = append(brackets, key[i+1:i+j])
			key = key[:i] + key[i+j+1:]
		}
		seg := Seg{Key: key, Index: -1}
		for n, b := range brackets {
			// Only the first bracket can ride on this segment; further
			// brackets ("a[0][1]") become key-less segments of their own.
			target := &seg
			if n > 0 {
				segs = append(segs, *target)
				seg = Seg{Index: -1}
				target = &seg
			}
			if k, v, ok := strings.Cut(b, "="); ok {
				target.SelKey = strings.TrimSpace(k)
				target.SelVal = strings.TrimSpace(v)
				continue
			}
			idx, err := strconv.Atoi(strings.TrimSpace(b))
			if err != nil || idx < 0 {
				return nil, fmt.Errorf("invalid index %q in path segment %q", b, part)
			}
			target.Index = idx
		}
		segs = append(segs, seg)
	}
	return segs, nil
}

// splitDots splits on '.' outside brackets, so selector values may contain
// dots ("rules[cidr=10.0.0.0/8]").
func splitDots(s string) []string {
	var parts []string
	depth, start := 0, 0
	for i, r := range s {
		switch r {
		case '[':
			depth++
		case ']':
			if depth > 0 {
				depth--
			}
		case '.':
			if depth == 0 {
				parts = append(parts, s[start:i])
				start = i + 1
			}
		}
	}
	parts = append(parts, s[start:])
	return parts
}
