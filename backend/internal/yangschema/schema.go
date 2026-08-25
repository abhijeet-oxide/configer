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
	// cannot express as a type restriction. They are what a reader is SHOWN; the
	// machine-readable originals live in Musts / Whens / Uniques, because a
	// full-document validator can act on those and a sentence is only ever
	// something to read.
	Constraints     []string
	DependencyPaths []string
	// Musts and Whens are the raw XPath conditions, kept so document-level
	// validation can evaluate them. A "when" is a condition on the node
	// EXISTING; a "must" is a condition on the tree once it does.
	Musts []Condition
	Whens []Condition
	// Uniques are the leaf routes a list's entries must not repeat, one entry
	// per "unique" statement (a statement may name several leaves, which are
	// unique in combination, not individually).
	Uniques [][]string
	// Presence marks a container whose mere existence carries meaning, so an
	// empty one is not the same as an absent one.
	Presence bool
	// Status is "current", "deprecated" or "obsolete" - the vendor's own word
	// on whether a setting should still be used.
	Status string
	// IfFeatures are the feature expressions gating this node's existence.
	IfFeatures []string
	// FeatureOff is set when the deployment's declared feature set does not
	// include what this node needs. The node is kept anyway - see
	// Set.applyFeatures - so its rules still explain the value in front of the
	// user; document validation reports it as a warning rather than an error.
	FeatureOff bool
	// Choice / Case name the choice construct this node was declared under, so
	// document validation can enforce that only one case's nodes are present.
	// Empty for the overwhelming majority of nodes, which are under no choice.
	Choice string
	Case   string
	// ChoiceMandatory marks a choice that must have exactly one case chosen.
	ChoiceMandatory bool
	// OrderedBy is "user" or "system"; only the former makes entry order
	// meaningful.
	OrderedBy string
	// Synthetic marks a node this package invented to spell out the route an
	// augment names, rather than one the schema declared. It exists to be
	// merged into the real declaration, never to stand in for it.
	Synthetic bool
	Module    string
	File      string
	Children  []*Node
}

// Condition is one "must" or "when" expression with the wording the schema gave
// for its failure.
type Condition struct {
	Expr         string
	ErrorMessage string
}

// addMust records a must expression on the node, along with the dependency it
// implies.
func (n *Node) addMust(st *Statement) {
	expr := collapse(st.Arg)
	if expr == "" {
		return
	}
	for _, existing := range n.Musts {
		if existing.Expr == expr {
			return
		}
	}
	n.Musts = append(n.Musts, Condition{Expr: expr, ErrorMessage: collapse(st.ChildArg("error-message"))})
	for _, p := range pathRefs(expr) {
		n.DependencyPaths = appendUnique(n.DependencyPaths, p)
	}
}

// dropMust removes a must expression a deviation deleted.
func (n *Node) dropMust(expr string) {
	expr = collapse(expr)
	out := n.Musts[:0]
	for _, m := range n.Musts {
		if m.Expr != expr {
			out = append(out, m)
		}
	}
	n.Musts = out
}

// Editable reports whether a value of this node is something a person may set.
// Operational state and an obsolete setting are both shown and neither is
// written: one belongs to the device, the other to a release nobody should be
// building against any more.
func (n *Node) Editable() bool { return n.Config && n.Status != "obsolete" }

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
	Bits           []Bit
	FractionDigits int
	LeafrefPath    string
	// RequireInstance is the leafref/instance-identifier modifier: false means
	// the reference may point at something that does not exist yet, so document
	// validation must not refuse it.
	RequireInstance *bool
	Union           []*Type
	// IdentityBase is the base of an identityref, from which the allowed values
	// are the identities deriving from it.
	IdentityBase string
	// Identities are those derived values, resolved once the whole set is read.
	Identities []string
	// Default / Units / Description may be declared on a TYPEDEF rather than on
	// the leaf using it, which is where a shared type keeps the fallback and the
	// unit that belong to the type itself. Read only from the leaf, every leaf
	// of a well-factored model came out with no default and no unit.
	Default     string
	Units       string
	Description string
	// ErrorMessage is the schema's own wording for a failed restriction.
	ErrorMessage string
}

// Bit is one named flag of a "bits" type.
type Bit struct {
	Name        string
	Position    int
	Description string
}

// BitNames returns just the flag names.
func (t *Type) BitNames() []string {
	if t == nil || len(t.Bits) == 0 {
		return nil
	}
	out := make([]string, 0, len(t.Bits))
	for _, b := range t.Bits {
		if b.Name != "" {
			out = append(out, b.Name)
		}
	}
	return out
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
		case name == "choice":
			// A choice is an authoring construct: the data tree underneath it
			// is addressed as if it were not there. But WHICH branch a document
			// took is a real constraint, so every node under it is stamped with
			// the choice and the case it belongs to - that is the only way a
			// document validator can later say "these two cannot both be set".
			mandatory := sub.ChildArg("mandatory") == "true"
			for _, c := range sub.Sub {
				switch c.Name() {
				case "case":
					stampChoice(m.buildNodes(c, defs, depth+2), sub.Arg, c.Arg, mandatory, &out)
				default:
					// A shorthand case: one data node standing in for a case of
					// its own name.
					if dataKeywords[c.Name()] {
						if n := m.buildNode(c, defs, depth+1); n != nil {
							stampChoice([]*Node{n}, sub.Arg, c.Arg, mandatory, &out)
						}
					}
				}
			}
		case name == "case":
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

// stampChoice records which choice and case a set of nodes was declared under
// and adds them to the parent's child list.
func stampChoice(nodes []*Node, choice, kase string, mandatory bool, out *[]*Node) {
	for _, n := range nodes {
		n.Choice, n.Case, n.ChoiceMandatory = bare(choice), bare(kase), mandatory
		*out = append(*out, n)
	}
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
	node := &Node{Name: steps[len(steps)-1], Kind: "container", Config: true, Synthetic: true, Module: m.Name, File: m.File, Children: children}
	for i := len(steps) - 2; i >= 0; i-- {
		node = &Node{Name: steps[i], Kind: "container", Config: true, Synthetic: true, Module: m.Name, File: m.File, Children: []*Node{node}}
	}
	return node
}

// Merge folds another node describing the SAME place in the tree into this one.
//
// An augment declares its target's whole route, so reading a module set
// produces two nodes called "radio": the module's own list-bearing one and the
// bare wrapper the augment spelled to reach it. Left side by side, whichever
// happened to be read first (which is whichever filename sorted first, so
// "acme-radio-extras.yang" before "acme-radio.yang") became the tree, and a
// walk down it found one leaf where the model has fifteen.
//
// So the two are merged: a real declaration outranks a synthesized wrapper for
// everything the node itself says, and their children are merged in turn.
func (n *Node) Merge(other *Node) {
	if other == nil || n == other {
		return
	}
	if n.Synthetic && !other.Synthetic {
		// The other node is the real declaration: take its identity wholesale
		// and keep only the children this wrapper contributed.
		mine := n.Children
		kind, module, file := other.Kind, other.Module, other.File
		contributed := *other
		*n = contributed
		n.Kind, n.Module, n.File, n.Synthetic = kind, module, file, false
		n.Children = append(append([]*Node{}, other.Children...), mine...)
		n.dedupeChildren()
		return
	}
	if n.Type == nil {
		n.Type = other.Type
	}
	n.Description = firstArg(n.Description, other.Description)
	n.Label = firstArg(n.Label, other.Label)
	n.Units = firstArg(n.Units, other.Units)
	n.Default = firstArg(n.Default, other.Default)
	n.Mandatory = n.Mandatory || other.Mandatory
	n.Presence = n.Presence || other.Presence
	if len(n.Keys) == 0 {
		n.Keys = other.Keys
	}
	if n.MinElements == nil {
		n.MinElements = other.MinElements
	}
	if n.MaxElements == nil {
		n.MaxElements = other.MaxElements
	}
	n.Musts = append(n.Musts, other.Musts...)
	n.Whens = append(n.Whens, other.Whens...)
	for _, u := range other.Uniques {
		n.Uniques = appendUniqueList(n.Uniques, u)
	}
	for _, d := range other.DependencyPaths {
		n.DependencyPaths = appendUnique(n.DependencyPaths, d)
	}
	n.Children = append(n.Children, other.Children...)
	n.dedupeChildren()
	n.Constraints = describeConditions(n)
}

// dedupeChildren merges children sharing a name, which is what an augment
// contributing into an existing container produces.
func (n *Node) dedupeChildren() { n.Children = mergeSiblings(n.Children) }

// mergeSiblings folds a list of nodes so that one name appears once, with
// everything every declaration of it said. Declaration order is preserved: the
// tree a reader walks should look like the model they read.
func mergeSiblings(nodes []*Node) []*Node {
	if len(nodes) < 2 {
		return nodes
	}
	seen := map[string]*Node{}
	out := nodes[:0]
	for _, c := range nodes {
		key := strings.ToLower(c.Name)
		if first, taken := seen[key]; taken {
			first.Merge(c)
			continue
		}
		seen[key] = c
		out = append(out, c)
	}
	return out
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
		Status:      strings.TrimSpace(st.ChildArg("status")),
		Presence:    st.Child("presence") != nil,
		OrderedBy:   strings.TrimSpace(st.ChildArg("ordered-by")),
		Module:      m.Name,
		File:        m.File,
	}
	if st.ChildArg("mandatory") == "true" {
		n.Mandatory = true
	}
	for _, f := range st.Children("if-feature") {
		if f.Arg != "" {
			n.IfFeatures = appendUnique(n.IfFeatures, collapse(f.Arg))
		}
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
	for _, u := range st.Children("unique") {
		if u.Arg != "" {
			n.Uniques = appendUniqueList(n.Uniques, strings.Fields(u.Arg))
		}
	}
	for _, c := range st.Children("must") {
		n.addMust(c)
	}
	for _, c := range st.Children("when") {
		if expr := collapse(c.Arg); expr != "" {
			n.Whens = append(n.Whens, Condition{Expr: expr, ErrorMessage: collapse(c.ChildArg("error-message"))})
			for _, p := range pathRefs(expr) {
				n.DependencyPaths = appendUnique(n.DependencyPaths, p)
			}
		}
	}
	n.Constraints = describeConditions(n)

	if t := st.Child("type"); t != nil {
		n.Type = resolveType(t, defs, 0)
		if n.Type != nil {
			if n.Type.LeafrefPath != "" {
				n.DependencyPaths = appendUnique(n.DependencyPaths, n.Type.LeafrefPath)
			}
			// A typedef carries its own default and unit; the leaf only
			// overrides them. Reading the leaf alone left every user of a
			// well-factored shared type with neither.
			if n.Default == "" {
				n.Default = n.Type.Default
			}
			if n.Units == "" {
				n.Units = n.Type.Units
			}
			if n.Description == "" {
				n.Description = n.Type.Description
			}
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

// describeConditions words every constraint the type system cannot carry, for
// a reader rather than an engine. The engine gets the expressions themselves
// from Musts / Whens / Uniques; this is what appears beside the editor, so it
// prefers the vendor's own error message and falls back to the expression only
// because a condition nobody can see is worse than one stated in XPath.
func describeConditions(n *Node) []string {
	var out []string
	add := func(c Condition, prefix string) {
		if c.ErrorMessage != "" {
			out = append(out, c.ErrorMessage)
			return
		}
		if c.Expr != "" {
			out = append(out, prefix+c.Expr)
		}
	}
	for _, c := range n.Whens {
		add(c, "applies when ")
	}
	for _, c := range n.Musts {
		add(c, "must satisfy ")
	}
	for _, u := range n.Uniques {
		out = append(out, "unique: "+strings.Join(u, ", "))
	}
	switch n.Status {
	case "deprecated":
		out = append(out, "deprecated: the vendor advises against new use")
	case "obsolete":
		out = append(out, "obsolete: no longer supported")
	}
	for _, f := range n.IfFeatures {
		out = append(out, "available only where the feature \""+f+"\" is supported")
	}
	if !n.Config {
		out = append(out, "read-only: reported by the device, not configured")
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
		// A typedef may carry the default, the unit and the prose that belong
		// to the TYPE rather than to any one leaf using it. The nearest
		// definition wins, which is why these are only filled when the inner
		// resolution left them empty.
		if v := td.ChildArg("default"); v != "" && t.Default == "" {
			t.Default = v
		}
		if v := td.ChildArg("units"); v != "" && t.Units == "" {
			t.Units = v
		}
		if v := collapse(td.ChildArg("description")); v != "" && t.Description == "" {
			t.Description = v
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
		if b.Arg == "" {
			continue
		}
		pos, _ := parseInt(b.ChildArg("position"))
		r.Bits = append(r.Bits, Bit{Name: b.Arg, Position: pos, Description: collapse(b.ChildArg("description"))})
	}
	if fd, ok := parseInt(st.ChildArg("fraction-digits")); ok {
		r.FractionDigits = fd
	}
	if p := st.ChildArg("path"); p != "" {
		r.LeafrefPath = p
	}
	if v := st.ChildArg("require-instance"); v != "" {
		b := v == "true"
		r.RequireInstance = &b
	}
	if b := st.ChildArg("base"); b != "" {
		r.IdentityBase = b
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
	if r.RequireInstance != nil {
		t.RequireInstance = r.RequireInstance
	}
	if r.IdentityBase != "" {
		t.IdentityBase = r.IdentityBase
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
		if u := ref.ChildArg("units"); u != "" {
			target.Units = u
		}
		// A refine ADDS musts rather than replacing them (RFC 7950 §7.13.2):
		// the grouping's own conditions still hold at the call site.
		for _, mst := range ref.Children("must") {
			target.addMust(mst)
		}
		target.Constraints = describeConditions(target)
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
