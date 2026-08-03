// Package pathmatch is the glob dialect the whole platform speaks: the familiar
// `**` form people already write in .gitignore, tsconfig and every CI file,
// implemented once so scopes, analyzer triggers, cache inputs and ignore lists
// cannot disagree about what a pattern means.
//
// Deliberately not a dependency: the semantics are small, and a shared
// definition inside the repository is worth more than a third-party one that
// differs subtly from what the rest of the toolchain does.
package pathmatch

import (
	"path"
	"strings"
)

// Match reports whether a slash-separated path matches a glob.
//
// Supported: `*` (any run of characters except `/`), `?` (one character except
// `/`), `**` (any number of path segments, including none), character classes
// `[abc]` via path.Match, and a brace list `{a,b}` expanded before matching.
// A pattern with no `/` matches by basename too, so `*.md` finds `docs/x.md`,
// which is what everybody expects and nobody remembers to write.
func Match(pattern, name string) bool {
	pattern = strings.TrimPrefix(path.Clean(pattern), "./")
	name = strings.TrimPrefix(path.Clean(name), "./")
	for _, p := range expandBraces(pattern) {
		if matchOne(p, name) {
			return true
		}
	}
	return false
}

// MatchAny reports whether any of the patterns matches.
func MatchAny(patterns []string, name string) bool {
	for _, p := range patterns {
		if Match(p, name) {
			return true
		}
	}
	return false
}

// MatchAnyOf reports whether any of the names matches any of the patterns.
func MatchAnyOf(patterns, names []string) bool {
	for _, n := range names {
		if MatchAny(patterns, n) {
			return true
		}
	}
	return false
}

// Filter returns the names that match at least one pattern.
func Filter(patterns, names []string) []string {
	out := make([]string, 0, len(names))
	for _, n := range names {
		if MatchAny(patterns, n) {
			out = append(out, n)
		}
	}
	return out
}

// Reject returns the names that match none of the patterns.
func Reject(patterns, names []string) []string {
	out := make([]string, 0, len(names))
	for _, n := range names {
		if !MatchAny(patterns, n) {
			out = append(out, n)
		}
	}
	return out
}

func matchOne(pattern, name string) bool {
	if pattern == "" {
		return false
	}
	// A bare `dir/**` should also match `dir` itself; treating the trailing
	// `**` as optional is the behaviour every ignore file has taught people.
	if segMatch(splitSegs(pattern), splitSegs(name)) {
		return true
	}
	if !strings.Contains(pattern, "/") {
		return segMatch(splitSegs(pattern), []string{path.Base(name)})
	}
	return false
}

func splitSegs(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(s, "/")
}

// segMatch is the ordinary recursive glob walk. `**` consumes zero or more
// segments, so it is the only case that branches.
func segMatch(pat, name []string) bool {
	for len(pat) > 0 {
		if pat[0] == "**" {
			// Trailing `**` matches whatever is left, including nothing.
			if len(pat) == 1 {
				return true
			}
			for i := 0; i <= len(name); i++ {
				if segMatch(pat[1:], name[i:]) {
					return true
				}
			}
			return false
		}
		if len(name) == 0 {
			return false
		}
		ok, err := path.Match(pat[0], name[0])
		if err != nil || !ok {
			return false
		}
		pat, name = pat[1:], name[1:]
	}
	return len(name) == 0
}

// expandBraces turns `a/{b,c}/d` into `a/b/d` and `a/c/d`. Only one level of
// nesting is supported, which covers every pattern anybody actually writes
// (`**/*.{ts,tsx}`) without dragging in a parser.
func expandBraces(p string) []string {
	open := strings.IndexByte(p, '{')
	if open < 0 {
		return []string{p}
	}
	close := strings.IndexByte(p[open:], '}')
	if close < 0 {
		return []string{p}
	}
	close += open
	prefix, body, suffix := p[:open], p[open+1:close], p[close+1:]
	parts := strings.Split(body, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		out = append(out, expandBraces(prefix+strings.TrimSpace(part)+suffix)...)
	}
	return out
}
