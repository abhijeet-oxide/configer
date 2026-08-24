package yangschema

import (
	"strconv"
	"strings"
)

// Node is one addressable node of a YANG data tree: a container, a list, or a
// leaf that actually holds a value. Everything the language says about it that
// a configuration UI can act on is flattened onto this struct - the prose, the
// label a vendor extension gave it, whether it must be set, and the type with
// its restrictions.
type Node struct {
	// Path is the model route from the root to this node, filled by the Set
	// indexer after augment/include expansion. It is not a YANG statement; it is
	// what lets a relative expression like "../enabled" resolve to another node.
	Path        []string
	Name        string
	Kind        string // container | list | leaf | leaf-list
	Description string
	Reference   string
	// Label is the human title a vendor extension attached to the node
	// ("alu:label", "nok-ext:label", "tailf:info", …). Any extension whose
	// keyword is "label" is taken, so this needs no per-vendor knowledge.
	Label     string
	Mandatory bool
	// Config is false for operational state, which is read-only by definition
	// and therefore never a tunable.
	Config      bool
	Units       string
	Default     string
	Keys        []string
	MinElements *int
	MaxElements *int
	Type        *Type
	// Constraints are the human sentences the schema attached to conditions it
	// cannot express as a type restriction: "must" error messages and "when"
	// expressions. They are shown, never enforced - enforcing an XPath
	// expression against a single value is not something this product does, and
	// hiding the condition would be worse than saying it in words.
	Constraints     []string
	DependencyPaths []string
	Module          string
	File            string
	Children        []*Node
}

// Type is a resolved YANG type: the builtin it bottoms out at, plus every
// restriction collected on the way down through the typedefs.
type Type struct {
	// Base is the YANG builtin ("string", "int16", "enumeration", …).
	Base string
	// Qualified is the type as the schema spelled it ("inet:ipv4-address"),
	// which is what carries the semantic the builtin has lost.
	Qualified      string
	Ranges         []Bound
	Lengths        []Bound
	Patterns       []Pattern
	Enums          []EnumValue
	Bits           []string
	FractionDigits int
	LeafrefPath    string
	Union          []*Type
	// ErrorMessage is the schema's own wording for a failed restriction.
	ErrorMessage string
}

// Bound is one span of a YANG "range" or "length" restriction. Either end may
// be open ("min"/"max"), which is a nil pointer here.
type Bound struct {
	Min *float64
	Max *float64
}

// Pattern is one YANG "pattern" restriction. Invert is set for the
// "invert-match" modifier.
type Pattern struct {
	Regex        string
	Invert       bool
	ErrorMessage string
}

// EnumValue is one member of an enumeration, with the prose that explains it.
type EnumValue struct {
	Name        string
	Description string
}

// builtins are the YANG base types; resolution stops at one of these.
var builtins = map[string]bool{
	"binary": true, "bits": true, "boolean": true, "decimal64": true,
	"empty": true, "enumeration": true, "identityref": true,
	"instance-identifier": true, "int8": true, "int16": true, "int32": true,
	"int64": true, "leafref": true, "string": true, "uint8": true,
	"uint16": true, "uint32": true, "uint64": true, "union": true,
}

// Module is one parsed YANG module or submodule.
type Module struct {
	Name      string
	Kind      string // module | submodule
	Namespace string
	Prefix    string
	BelongsTo string
	File      string
	root      *Statement
}

// definitions holds the typedefs and groupings visible while a module set is
// resolved. YANG scopes them per module and by import prefix; this indexes
// them by bare name across the whole set, which is what a set of submodules of
// one module actually needs and is right often enough that being stricter
// would cost validation rules for no gain.
type definitions struct {
	typedefs  map[string]*Statement
	groupings map[string]*Statement
}

func newDefinitions() *definitions {
	return &definitions{typedefs: map[string]*Statement{}, groupings: map[string]*Statement{}}
}

// collect records every typedef and grouping in a statement tree.
func (d *definitions) collect(st *Statement) {
	for _, sub := range st.Sub {
		switch sub.Name() {
		case "typedef":
			if sub.Arg != "" {
				if _, seen := d.typedefs[sub.Arg]; !seen {
					d.typedefs[sub.Arg] = sub
				}
			}
		case "grouping":
			if sub.Arg != "" {
				if _, seen := d.groupings[sub.Arg]; !seen {
					d.groupings[sub.Arg] = sub
				}
			}
		}
		d.collect(sub)
	}
}

// dataKeywords are the statements that introduce an addressable data node.
var dataKeywords = map[string]bool{
	"container": true, "list": true, "leaf": true, "leaf-list": true,
}

// buildNodes turns a statement's data-node children into Nodes, inlining
// groupings and flattening choice/case (a choice is an authoring construct;
// the data tree underneath it is addressed as if the choice were not there).
func (m *Module) buildNodes(parent *Statement, defs *definitions, depth int) []*Node {
	if depth > maxDepth {
		return nil
	}
	var out []*Node
	for _, sub := range parent.Sub {
		switch name := sub.Name(); {
		case dataKeywords[name]:
			if n := m.buildNode(sub, defs, depth); n != nil {
				out = append(out, n)
			}
		case name == "choice" || name == "case":
			out = append(out, m.buildNodes(sub, defs, depth+1)...)
		case name == "uses":
			g := defs.groupings[bare(sub.Arg)]
			if g == nil {
				continue
			}
			inlined := m.buildNodes(g, defs, depth+1)
			applyRefinements(inlined, sub)
			// A "uses" may also augment what it just inlined; the target is
			// relative to the grouping's own root.
			for _, aug := range sub.Children("augment") {
				if target := findByPath(inlined, strings.Split(aug.Arg, "/")); target != nil {
					target.Children = append(target.Children, m.buildNodes(aug, defs, depth+1)...)
				}
			}
			out = append(out, inlined...)
		case name == "augment":
			// An augment adds nodes to a tree defined ELSEWHERE, which is how
			// a product splits one model across a module and its includes -
			// and a quarter of a real model set is written this way. Reading
			// only what a file declares in place misses all of it, and the
			// settings come out with no type, no allowed values and no prose.
			//
			// The target is not resolved against the other modules: the
			// augment states the ABSOLUTE route it attaches at, and the route
			// is the only thing a lookup matches on. Spelling that route out
			// gives the same answer whether or not the module holding the
			// target ships with the product.
			if n := m.buildAugment(sub, defs, depth); n != nil {
				out = append(out, n)
			}
		}
	}
	return out
}

// buildAugment wraps an augment's nodes in the route its target names, so they
// are addressed the way the real tree addresses them.
func (m *Module) buildAugment(st *Statement, defs *definitions, depth int) *Node {
	children := m.buildNodes(st, defs, depth+1)
	if len(children) == 0 {
		return nil
	}
	steps := make([]string, 0, 4)
	for _, s := range strings.Split(st.Arg, "/") {
		if s = bare(strings.TrimSpace(s)); s != "" {
			steps = append(steps, s)
		}
	}
	if len(steps) == 0 {
		return nil
	}
	// The chain is built from the leaf end back, so the outermost step is what
	// comes out and the whole route is walked on the way to the real nodes.
	node := &Node{Name: steps[len(steps)-1], Kind: "container", Config: true, Module: m.Name, File: m.File, Children: children}
	for i := len(steps) - 2; i >= 0; i-- {
		node = &Node{Name: steps[i], Kind: "container", Config: true, Module: m.Name, File: m.File, Children: []*Node{node}}
	}
	return node
}

func (m *Module) buildNode(st *Statement, defs *definitions, depth int) *Node {
	if st.Arg == "" {
		return nil
	}
	n := &Node{
		Name:        bare(st.Arg),
		Kind:        st.Name(),
		Description: collapse(st.ChildArg("description")),
		Reference:   collapse(st.ChildArg("reference")),
		Label:       extensionArg(st, "label", "info"),
		Config:      st.ChildArg("config") != "false",
		Units:       st.ChildArg("units"),
		Module:      m.Name,
		File:        m.File,
	}
	if st.ChildArg("mandatory") == "true" {
		n.Mandatory = true
	}
	n.Default = firstArg(st.ChildArg("default"), extensionArg(st, "default"))
	if keys := st.ChildArg("key"); keys != "" {
		n.Keys = strings.Fields(keys)
	}
	if v, ok := parseInt(st.ChildArg("min-elements")); ok {
		n.MinElements = &v
	}
	if v, ok := parseInt(st.ChildArg("max-elements")); ok {
		n.MaxElements = &v
	}
	n.Constraints = conditions(st)
	n.DependencyPaths = dependencyPaths(st)

	if t := st.Child("type"); t != nil {
		n.Type = resolveType(t, defs, 0)
		if n.Type != nil && n.Type.LeafrefPath != "" {
			n.DependencyPaths = append(n.DependencyPaths, n.Type.LeafrefPath)
		}
	}
	// A list key is mandatory by definition, whether or not it says so.
	n.Children = m.buildNodes(st, defs, depth+1)
	for _, k := range n.Keys {
		for _, c := range n.Children {
			if c.Name == k {
				c.Mandatory = true
			}
		}
	}
	return n
}

// conditions collects the human wording of every constraint the type system
// cannot carry.
func conditions(st *Statement) []string {
	var out []string
	for _, c := range st.Children("must", "when") {
		if msg := collapse(c.ChildArg("error-message")); msg != "" {
			out = append(out, msg)
			continue
		}
		if expr := collapse(c.Arg); expr != "" {
			out = append(out, expr)
		}
	}
	for _, u := range st.Children("unique") {
		if u.Arg != "" {
			out = append(out, "unique: "+u.Arg)
		}
	}
	return out
}

// dependencyPaths extracts the path-like references from "must" and "when".
// The whole XPath language is larger than what is useful for the dependency
// graph, so this deliberately keeps only explicit node paths. They are later
// resolved to real parameters only if the target is unambiguous.
func dependencyPaths(st *Statement) []string {
	seen := map[string]bool{}
	var out []string
	for _, c := range st.Children("must", "when") {
		for _, p := range pathRefs(c.Arg) {
			if !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	return out
}

// resolveType reads a "type" statement and follows typedefs down to a builtin,
// merging restrictions as it goes: the closest one wins for range, length and
// enumeration, while patterns ACCUMULATE - YANG requires a value to match
// every pattern in the chain, not just the innermost.
func resolveType(st *Statement, defs *definitions, depth int) *Type {
	if depth > maxDepth {
		return nil
	}
	t := &Type{Qualified: st.Arg}
	local := restrictions(st, defs, depth)

	base := bare(st.Arg)
	if builtins[base] {
		t.Base = base
	} else if td := defs.typedefs[base]; td != nil {
		if inner := td.Child("type"); inner != nil {
			if resolved := resolveType(inner, defs, depth+1); resolved != nil {
				*t = *resolved
				// The type keeps the name the SCHEMA gave it, not the builtin
				// it resolved to: "inet:ipv4-address" carries a meaning that
				// "string" has thrown away.
				t.Qualified = st.Arg
			}
		}
	} else {
		// An unresolvable type (imported from a module we were not given)
		// still tells us its name, and its restrictions still apply.
		t.Base = "string"
	}

	mergeRestrictions(t, local)
	return t
}

// restrictions reads the restriction substatements of one "type" statement.
func restrictions(st *Statement, defs *definitions, depth int) *Type {
	r := &Type{}
	if b := st.Child("range"); b != nil {
		r.Ranges = parseBounds(b.Arg)
		r.ErrorMessage = firstArg(collapse(b.ChildArg("error-message")), r.ErrorMessage)
	}
	if b := st.Child("length"); b != nil {
		r.Lengths = parseBounds(b.Arg)
		r.ErrorMessage = firstArg(collapse(b.ChildArg("error-message")), r.ErrorMessage)
	}
	for _, p := range st.Children("pattern") {
		if p.Arg == "" {
			continue
		}
		r.Patterns = append(r.Patterns, Pattern{
			Regex:        p.Arg,
			Invert:       p.ChildArg("modifier") == "invert-match",
			ErrorMessage: collapse(p.ChildArg("error-message")),
		})
	}
	for _, e := range st.Children("enum") {
		r.Enums = append(r.Enums, EnumValue{Name: e.Arg, Description: collapse(e.ChildArg("description"))})
	}
	for _, b := range st.Children("bit") {
		r.Bits = append(r.Bits, b.Arg)
	}
	if fd, ok := parseInt(st.ChildArg("fraction-digits")); ok {
		r.FractionDigits = fd
	}
	if p := st.ChildArg("path"); p != "" {
		r.LeafrefPath = p
	}
	// A union's members are types in their own right; the value must satisfy
	// one of them, so no single restriction of theirs can be enforced alone.
	for _, u := range st.Children("type") {
		if m := resolveType(u, defs, depth+1); m != nil {
			r.Union = append(r.Union, m)
		}
	}
	return r
}

// mergeRestrictions layers a nearer restriction set over the resolved type.
func mergeRestrictions(t, r *Type) {
	if len(r.Ranges) > 0 {
		t.Ranges = r.Ranges
	}
	if len(r.Lengths) > 0 {
		t.Lengths = r.Lengths
	}
	if len(r.Enums) > 0 {
		t.Enums = r.Enums
	}
	if len(r.Bits) > 0 {
		t.Bits = r.Bits
	}
	if len(r.Union) > 0 {
		t.Union = r.Union
	}
	if r.FractionDigits != 0 {
		t.FractionDigits = r.FractionDigits
	}
	if r.LeafrefPath != "" {
		t.LeafrefPath = r.LeafrefPath
	}
	if r.ErrorMessage != "" {
		t.ErrorMessage = r.ErrorMessage
	}
	// Every pattern in the chain must hold, so these accumulate.
	t.Patterns = append(t.Patterns, r.Patterns...)
}

// applyRefinements applies a "uses" statement's refine clauses to the nodes it
// just inlined, so a grouping reused with a different description or a
// tightened mandatory flag reads the way its call site meant it to.
func applyRefinements(nodes []*Node, uses *Statement) {
	for _, ref := range uses.Children("refine") {
		target := findByPath(nodes, strings.Split(ref.Arg, "/"))
		if target == nil {
			continue
		}
		if d := collapse(ref.ChildArg("description")); d != "" {
			target.Description = d
		}
		if m := ref.ChildArg("mandatory"); m != "" {
			target.Mandatory = m == "true"
		}
		if d := ref.ChildArg("default"); d != "" {
			target.Default = d
		}
		if c := ref.ChildArg("config"); c != "" {
			target.Config = c != "false"
		}
		if v, ok := parseInt(ref.ChildArg("min-elements")); ok {
			target.MinElements = &v
		}
		if v, ok := parseInt(ref.ChildArg("max-elements")); ok {
			target.MaxElements = &v
		}
	}
}

func findByPath(nodes []*Node, steps []string) *Node {
	var cur *Node
	for _, step := range steps {
		step = bare(strings.TrimSpace(step))
		if step == "" {
			continue
		}
		list := nodes
		if cur != nil {
			list = cur.Children
		}
		cur = nil
		for _, n := range list {
			if n.Name == step {
				cur = n
				break
			}
		}
		if cur == nil {
			return nil
		}
	}
	return cur
}

// parseBounds reads a YANG range/length argument: one or more spans separated
// by "|", each "lo..hi" or a single exact value, with "min"/"max" for open
// ends.
func parseBounds(arg string) []Bound {
	var out []Bound
	for _, part := range strings.Split(arg, "|") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		lo, hi, split := strings.Cut(part, "..")
		var b Bound
		b.Min = parseBoundEnd(lo)
		if split {
			b.Max = parseBoundEnd(hi)
		} else {
			b.Max = b.Min
		}
		if b.Min != nil || b.Max != nil {
			out = append(out, b)
		}
	}
	return out
}

func parseBoundEnd(s string) *float64 {
	s = strings.TrimSpace(s)
	if s == "" || s == "min" || s == "max" {
		return nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	return &f
}

// Span returns the outermost low and high across every bound, which is what a
// single min/max rule can express. A multi-span restriction ("1..10|20..30")
// therefore validates loosely on its own - the exact spans travel separately
// so the UI can still say what they are.
func Span(bounds []Bound) (*float64, *float64) {
	var lo, hi *float64
	for _, b := range bounds {
		if b.Min == nil {
			lo = nil
		} else if lo == nil || *b.Min < *lo {
			v := *b.Min
			lo = &v
		}
		if b.Max == nil {
			hi = nil
		} else if hi == nil || *b.Max > *hi {
			v := *b.Max
			hi = &v
		}
	}
	return lo, hi
}

// extensionArg returns the argument of the first extension statement whose
// keyword (after its prefix) is one of names. Matching on the unprefixed
// keyword is what keeps this vendor-agnostic: "alu:label", "nok-ext:label" and
// "tailf:info" all answer the same question.
func extensionArg(st *Statement, names ...string) string {
	for _, sub := range st.Sub {
		if sub.Prefix() == "" {
			continue
		}
		for _, n := range names {
			if sub.Name() == n && sub.Arg != "" {
				return collapse(sub.Arg)
			}
		}
	}
	return ""
}

// bare strips a module prefix from an identifier.
func bare(s string) string {
	if i := strings.IndexByte(s, ':'); i > 0 {
		return s[i+1:]
	}
	return s
}

func firstArg(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func parseInt(s string) (int, bool) {
	s = strings.TrimSpace(s)
	if s == "" || s == "unbounded" {
		return 0, false
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, false
	}
	return n, true
}

// collapse folds a YANG description's wrapped indentation into one paragraph.
func collapse(s string) string {
	if s == "" {
		return ""
	}
	lines := strings.Split(s, "\n")
	for i := range lines {
		lines[i] = strings.TrimSpace(lines[i])
	}
	return strings.TrimSpace(strings.Join(lines, " "))
}
