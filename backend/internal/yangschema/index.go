// Package yangschema reads YANG models that ship alongside a repository's
// configuration and turns what they say into the product's own validation
// vocabulary: data type, required, allowed values, ranges, character limits,
// regular expressions, units and the prose that explains the setting.
//
// It is a RECOGNIZED PATTERN, not a requirement. A repository with no YANG in
// it behaves exactly as before. When models ARE present they outrank every
// guess: a range the vendor wrote down is a fact, where a rule inferred from a
// leaf name is a hunch.
//
// Nothing here is vendor-specific. Vendor extensions are read by their
// UNPREFIXED keyword ("label", "info"), so any vendor spelling them the same
// way is understood without being named.
package yangschema

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Limits keep one discovery run bounded on a large model set. A telco product
// ships hundreds of modules; reading all of them is fine, reading an unbounded
// number of them is how a scan becomes a hang.
const (
	maxFiles    = 4000
	maxFileSize = 4 << 20 // 4 MiB
)

// Set is a loaded collection of YANG modules and the lookup index over their
// data trees.
type Set struct {
	// Dirs are the repo-relative directories the models were read from.
	Dirs    []string
	Modules []*Module

	entries []entry
	byLeaf  map[string][]int
	byNode  map[*Node][]string
}

type entry struct {
	// path is the node's route from its module root, lowercased.
	path []string
	node *Node
}

// FindSchemaRoots returns the repo-relative directories that directly hold
// YANG models, nearest the root first. Any layout works: the models are found
// by what they ARE, not by a directory named the way one vendor names it.
func FindSchemaRoots(root string) []string {
	var dirs []string
	seen := map[string]bool{}
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil //nolint:nilerr // an unreadable subtree is not an error here
		}
		if d.IsDir() {
			name := d.Name()
			if name == ".git" || name == "node_modules" || name == ".configer" {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.EqualFold(filepath.Ext(d.Name()), ".yang") {
			return nil
		}
		rel, relErr := filepath.Rel(root, filepath.Dir(p))
		if relErr != nil {
			return nil
		}
		slash := filepath.ToSlash(rel)
		if !seen[slash] {
			seen[slash] = true
			dirs = append(dirs, slash)
		}
		return nil
	})
	sort.Slice(dirs, func(i, j int) bool {
		di, dj := strings.Count(dirs[i], "/"), strings.Count(dirs[j], "/")
		if di != dj {
			return di < dj
		}
		return dirs[i] < dirs[j]
	})
	return dirs
}

// ForVersion narrows a set of model directories to the ones belonging to a
// software release, by matching the version against the path itself. A product
// that ships several releases side by side (schema/25.7/…, schema/26.1/…) then
// validates each instance against the models it was actually built from.
//
// A version that matches nothing returns every directory: validating against
// the models that are there beats validating against none.
func ForVersion(dirs []string, version string) []string {
	version = strings.TrimSpace(version)
	if version == "" {
		return dirs
	}
	var hit []string
	for _, d := range dirs {
		for _, seg := range strings.Split(d, "/") {
			if strings.EqualFold(seg, version) {
				hit = append(hit, d)
				break
			}
		}
	}
	if len(hit) == 0 {
		return dirs
	}
	return hit
}

// Load parses every model in dirs (repo-relative, non-recursive per directory)
// and builds the lookup index. Files that do not parse are passed over: one
// unreadable model must not cost the validation the other five hundred carry.
func Load(root string, dirs []string) *Set {
	set := &Set{Dirs: dirs, byLeaf: map[string][]int{}, byNode: map[*Node][]string{}}
	defs := newDefinitions()

	type parsed struct {
		mod *Module
		st  *Statement
	}
	var mods []parsed
	count := 0
	for _, dir := range dirs {
		entries, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(dir)))
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".yang") {
				continue
			}
			if count >= maxFiles {
				break
			}
			rel := dir + "/" + e.Name()
			if dir == "." {
				rel = e.Name()
			}
			info, statErr := e.Info()
			if statErr != nil || info.Size() > maxFileSize {
				continue
			}
			content, readErr := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
			if readErr != nil {
				continue
			}
			st, parseErr := Parse(content)
			if parseErr != nil || st == nil {
				continue
			}
			kind := st.Name()
			if kind != "module" && kind != "submodule" {
				continue
			}
			count++
			m := &Module{
				Name:      st.Arg,
				Kind:      kind,
				Namespace: st.ChildArg("namespace"),
				Prefix:    st.ChildArg("prefix"),
				File:      rel,
				root:      st,
			}
			if bt := st.Child("belongs-to"); bt != nil {
				m.BelongsTo = bt.Arg
			}
			// Definitions are collected across the WHOLE set first: a submodule
			// routinely uses a typedef its sibling declares, and resolving each
			// file alone would lose every restriction those types carry.
			defs.collect(st)
			mods = append(mods, parsed{mod: m, st: st})
		}
	}

	for _, p := range mods {
		set.Modules = append(set.Modules, p.mod)
		for _, n := range p.mod.buildNodes(p.st, defs, 0) {
			set.index(nil, n)
		}
	}
	return set
}

// Empty reports whether the set carries no usable models.
func (s *Set) Empty() bool { return s == nil || len(s.entries) == 0 }

// Nodes returns how many data nodes the set indexed.
func (s *Set) Nodes() int {
	if s == nil {
		return 0
	}
	return len(s.entries)
}

func (s *Set) index(prefix []string, n *Node) {
	path := append(append([]string{}, prefix...), strings.ToLower(n.Name))
	n.Path = append([]string{}, path...)
	idx := len(s.entries)
	s.entries = append(s.entries, entry{path: path, node: n})
	s.byLeaf[path[len(path)-1]] = append(s.byLeaf[path[len(path)-1]], idx)
	s.byNode[n] = path
	for _, c := range n.Children {
		s.index(path, c)
	}
}

// Lookup finds the model node a value's path steps address.
//
// Matching is by NAME ROUTE, not by namespace: a configuration document spells
// its elements with its own prefixes and a YANG module never sees them, so the
// only thing the two share is the chain of names. The best match is the one
// agreeing on the most trailing steps - a route that agrees on four steps says
// far more than one agreeing on the leaf alone.
//
// An ambiguous match is NO match. Two different models that both end in "port"
// would otherwise have the first one silently decide what a value may be, and
// a rule attributed to a schema it did not come from is worse than no rule.
func (s *Set) Lookup(steps []string) (*Node, bool) {
	return s.lookup(steps, nil)
}

func (s *Set) lookup(steps []string, exclude *Node) (*Node, bool) {
	if s == nil || len(steps) == 0 {
		return nil, false
	}
	norm := normalize(steps)
	if len(norm) == 0 {
		return nil, false
	}
	leaf := norm[len(norm)-1]
	best, bestScore := (*Node)(nil), 0
	ambiguous := false
	for _, idx := range s.byLeaf[leaf] {
		e := s.entries[idx]
		if e.node == exclude {
			continue
		}
		if len(e.node.Children) > 0 {
			continue // only leaves hold values
		}
		score := commonSuffix(e.path, norm)
		if score == 0 {
			continue
		}
		switch {
		case score > bestScore:
			best, bestScore, ambiguous = e.node, score, false
		case score == bestScore && best != nil && fingerprint(e.node) != fingerprint(best):
			ambiguous = true
		}
	}
	if ambiguous || best == nil {
		return nil, false
	}
	return best, true
}

// LookupDependency resolves one schema expression path from source to another
// model node. Relative paths are resolved against the source's own route;
// absolute paths are used as written. The answer is false when the expression
// points at the source itself, a structural container/list, or an ambiguous
// target.
func (s *Set) LookupDependency(source *Node, expr string) (*Node, bool) {
	if s == nil || source == nil {
		return nil, false
	}
	steps := dependencySteps(source.Path, expr)
	if len(steps) == 0 {
		return nil, false
	}
	return s.lookup(steps, source)
}

// normalize reduces raw path steps to the names a model would know: module
// prefixes, attribute markers and positional indices all describe the
// DOCUMENT, never the model.
func normalize(steps []string) []string {
	out := make([]string, 0, len(steps))
	for _, s := range steps {
		s = strings.TrimPrefix(s, "@")
		if i := strings.IndexByte(s, '['); i >= 0 {
			s = s[:i]
		}
		if i := strings.IndexByte(s, ':'); i > 0 {
			s = s[i+1:]
		}
		s = strings.ToLower(strings.TrimSpace(s))
		if s == "" || isNumeric(s) {
			continue
		}
		out = append(out, s)
	}
	return out
}

var pathRefRe = regexp.MustCompile(`(?:\.\./|/)[A-Za-z_][A-Za-z0-9_.:-]*(?:\[[^\]]+\])?(?:/[A-Za-z_][A-Za-z0-9_.:-]*(?:\[[^\]]+\])?)*`)

func pathRefs(expr string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range pathRefRe.FindAllString(expr, -1) {
		m = strings.TrimSpace(m)
		if m == "" || seen[m] {
			continue
		}
		seen[m] = true
		out = append(out, m)
	}
	return out
}

func dependencySteps(source []string, expr string) []string {
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return nil
	}
	if strings.HasPrefix(expr, "/") {
		return strings.Split(strings.Trim(expr, "/"), "/")
	}
	base := append([]string{}, source...)
	if len(base) > 0 {
		base = base[:len(base)-1]
	}
	for strings.HasPrefix(expr, "../") {
		if len(base) > 0 {
			base = base[:len(base)-1]
		}
		expr = strings.TrimPrefix(expr, "../")
	}
	if expr == "." || expr == "" {
		return base
	}
	return append(base, strings.Split(strings.Trim(expr, "/"), "/")...)
}

func isNumeric(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

// commonSuffix counts the trailing elements two routes agree on.
func commonSuffix(a, b []string) int {
	n := 0
	for n < len(a) && n < len(b) && a[len(a)-1-n] == b[len(b)-1-n] {
		n++
	}
	return n
}

// fingerprint summarizes everything about a node that changes the rules it
// produces, so two matches that say the same thing are not called a conflict.
func fingerprint(n *Node) string {
	var b strings.Builder
	b.WriteString(n.Kind)
	b.WriteByte('|')
	if n.Mandatory {
		b.WriteString("req")
	}
	b.WriteByte('|')
	if n.Type != nil {
		b.WriteString(n.Type.Base)
		b.WriteByte('/')
		b.WriteString(n.Type.Qualified)
		for _, r := range n.Type.Ranges {
			b.WriteString(boundKey(r))
		}
		for _, l := range n.Type.Lengths {
			b.WriteString(boundKey(l))
		}
		for _, p := range n.Type.Patterns {
			b.WriteString(p.Regex)
		}
		for _, e := range n.Type.Enums {
			b.WriteString(e.Name)
			b.WriteByte(',')
		}
	}
	return b.String()
}

func boundKey(b Bound) string {
	f := func(p *float64) string {
		if p == nil {
			return "*"
		}
		return strings.TrimRight(strings.TrimRight(formatFloat(*p), "0"), ".")
	}
	return f(b.Min) + ".." + f(b.Max) + ";"
}
