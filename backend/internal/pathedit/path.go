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
	// Quoted marks a key that arrived in the ['…'] form. It is what tells a
	// bare index apart from a deliberately empty key, so the engine can refuse
	// the first and honor the second instead of guessing from Key == "".
	Quoted bool
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
//
// A key that the dotted form cannot express - one containing "." or brackets,
// or the empty string - is written quoted inside brackets:
//
//	$.value['query.dependencies'].dagMaxNumService
//
// Without that spelling, "query.dependencies" reads as two steps: the path
// resolves to nothing, and writing it builds a nested `query: {dependencies:
// {...}}` on top of the real key. Both failures are silent, which is why the
// quoted form exists rather than a rule that such keys are unsupported.
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
			j := BracketEnd(key, i)
			if j < 0 {
				return nil, fmt.Errorf("unclosed '[' in path segment %q", part)
			}
			brackets = append(brackets, key[i+1:j])
			key = key[:i] + key[j+1:]
		}
		// The dotted key, when the part had one ("servers[2]" -> "servers").
		seg := Seg{Key: key, Index: -1}
		started := key != ""
		flush := func() {
			segs = append(segs, seg)
			seg = Seg{Index: -1}
			started = false
		}
		for _, b := range brackets {
			// A QUOTED bracket is a key, not a subscript: ['a.b'] addresses the
			// single key "a.b". It always begins a step of its own, because a
			// key never rides on the same node as the key before it.
			if q, isQuoted := UnquoteKey(b); isQuoted {
				if started {
					flush()
				}
				seg = Seg{Key: q, Index: -1, Quoted: true}
				flush()
				continue
			}
			// A subscript rides on the step it follows; a second one ("a[0][1]")
			// starts a key-less step of its own.
			if seg.Index >= 0 || seg.SelKey != "" {
				flush()
			}
			if k, v, ok := strings.Cut(b, "="); ok {
				seg.SelKey = strings.TrimSpace(k)
				seg.SelVal = strings.TrimSpace(v)
				started = true
				continue
			}
			idx, err := strconv.Atoi(strings.TrimSpace(b))
			if err != nil || idx < 0 {
				return nil, fmt.Errorf("invalid index %q in path segment %q", b, part)
			}
			seg.Index = idx
			started = true
		}
		if started || len(brackets) == 0 {
			segs = append(segs, seg)
		}
	}
	return segs, nil
}

// UnquoteKey reads the contents of a bracket as a quoted key, reporting
// whether it was quoted at all. Only the outer quotes are stripped; a key
// containing a quote of the other kind survives intact.
func UnquoteKey(b string) (string, bool) {
	if len(b) >= 2 {
		q := b[0]
		if (q == '\'' || q == '"') && b[len(b)-1] == q {
			inner := b[1 : len(b)-1]
			return strings.ReplaceAll(inner, `\`+string(q), string(q)), true
		}
	}
	return "", false
}

// QuoteKey renders one mapping key as a path segment, quoting it when the
// dotted form cannot carry it. Every producer of a path (the scanners, the
// path picker) goes through here, so a key with a dot in it is spelled the
// same way everywhere and the engine can always find it again.
func QuoteKey(key string) string {
	if key != "" && !strings.ContainsAny(key, ".[]'\"") {
		return key
	}
	return "['" + strings.ReplaceAll(key, `'`, `\'`) + "']"
}

// JoinKey appends a mapping key to a path, choosing the separator the key's
// spelling requires: a quoted key brackets onto the path with no dot.
func JoinKey(path, key string) string {
	seg := QuoteKey(key)
	if strings.HasPrefix(seg, "[") {
		return path + seg
	}
	return path + "." + seg
}

// splitDots splits on '.' outside brackets, so selector values may contain
// dots ("rules[cidr=10.0.0.0/8]").
func splitDots(s string) []string {
	var parts []string
	depth, start := 0, 0
	var quote byte // the quote character currently open inside a bracket, 0 when none
	for i := 0; i < len(s); i++ {
		c := s[i]
		if quote != 0 {
			// Inside ['…'] nothing is structural: a key is allowed to contain
			// dots and brackets, which is the whole reason for quoting it.
			if c == '\\' && i+1 < len(s) {
				i++
				continue
			}
			if c == quote {
				quote = 0
			}
			continue
		}
		switch c {
		case '\'', '"':
			if depth > 0 {
				quote = c
			}
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

// BracketEnd returns the index of the ']' that closes the '[' at open,
// skipping over any quoted key inside it.
func BracketEnd(s string, open int) int {
	var quote byte
	for i := open + 1; i < len(s); i++ {
		c := s[i]
		if quote != 0 {
			if c == '\\' && i+1 < len(s) {
				i++
				continue
			}
			if c == quote {
				quote = 0
			}
			continue
		}
		switch c {
		case '\'', '"':
			quote = c
		case ']':
			return i
		}
	}
	return -1
}
