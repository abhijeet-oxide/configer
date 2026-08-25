package yangvalidate

// YANG's "must" and "when" are XPath 1.0, and XPath 1.0 is a whole language.
// Implementing it properly is what libyang is for; what lives here is a
// deliberately SMALL subset covering the shapes that real models actually use
// for configuration constraints:
//
//	../enabled = 'true'
//	count(./neighbour) > 0
//	not(../mode = 'auto') or ../interval >= 10
//	string-length(./name) < 32
//
// Every expression outside that subset returns "not known", and a caller that
// gets "not known" must say nothing rather than assume either answer. This is
// the single rule the file exists to keep: a condition guessed at is worse than
// one nobody checked, because a reader cannot tell the two apart, and a false
// refusal on a correct change is how people learn to click past the gate.

import (
	"fmt"
	"strconv"
	"strings"
)

// evalContext is where an expression is being evaluated from.
type evalContext struct {
	root *Node
	node *Node
	// ancestry runs root-first down to the PARENT of node, which is what ".."
	// walks back up.
	ancestry []*Node
}

// evalXPath evaluates one expression to a boolean. The second result is false
// when the expression is outside the subset this reads.
func evalXPath(expr string, ctx evalContext) (result bool, known bool) {
	toks, ok := lex(expr)
	if !ok {
		return false, false
	}
	p := &xparser{toks: toks, ctx: ctx}
	v, ok := p.orExpr()
	if !ok || p.i != len(p.toks) {
		return false, false
	}
	b, ok := v.boolean()
	return b, ok
}

// value is one intermediate result: a node set, a string, a number or a
// boolean. XPath's conversions between them are the fiddly part, and the ones
// implemented here are the ones the subset needs.
type value struct {
	nodes  []*Node
	isNode bool
	str    string
	isStr  bool
	num    float64
	isNum  bool
	b      bool
	isBool bool
}

func nodeVal(n []*Node) value { return value{nodes: n, isNode: true} }
func strVal(s string) value   { return value{str: s, isStr: true} }
func numVal(f float64) value  { return value{num: f, isNum: true} }
func boolVal(b bool) value    { return value{b: b, isBool: true} }

// boolean converts to a boolean the way XPath does: a non-empty node set is
// true, a non-empty string is true, a non-zero number is true.
func (v value) boolean() (bool, bool) {
	switch {
	case v.isBool:
		return v.b, true
	case v.isNode:
		return len(v.nodes) > 0, true
	case v.isStr:
		return v.str != "", true
	case v.isNum:
		return v.num != 0, true
	}
	return false, false
}

// number converts to a number, reporting false when the value is not one. A
// node set uses its first node, as XPath does.
func (v value) number() (float64, bool) {
	switch {
	case v.isNum:
		return v.num, true
	case v.isBool:
		if v.b {
			return 1, true
		}
		return 0, true
	case v.isStr:
		f, err := strconv.ParseFloat(strings.TrimSpace(v.str), 64)
		return f, err == nil
	case v.isNode:
		if len(v.nodes) == 0 {
			return 0, false
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(nodeString(v.nodes[0])), 64)
		return f, err == nil
	}
	return 0, false
}

// strings returns every string this value compares as. A node set compares as
// ANY of its members, which is what makes "../a = 'x'" true when one of several
// nodes says x.
func (v value) strings() []string {
	switch {
	case v.isStr:
		return []string{v.str}
	case v.isBool:
		return []string{strconv.FormatBool(v.b)}
	case v.isNum:
		return []string{trimFloat(v.num)}
	case v.isNode:
		out := make([]string, 0, len(v.nodes))
		for _, n := range v.nodes {
			out = append(out, nodeString(n))
		}
		return out
	}
	return nil
}

func nodeString(n *Node) string {
	if n == nil {
		return ""
	}
	if n.Leaf() {
		return fmt.Sprintf("%v", n.Scalar)
	}
	return ""
}

func trimFloat(f float64) string { return strconv.FormatFloat(f, 'g', -1, 64) }

// ---- parser -------------------------------------------------------------

type xparser struct {
	toks []string
	i    int
	ctx  evalContext
}

func (p *xparser) peek() string {
	if p.i < len(p.toks) {
		return p.toks[p.i]
	}
	return ""
}

func (p *xparser) orExpr() (value, bool) {
	left, ok := p.andExpr()
	if !ok {
		return value{}, false
	}
	for p.peek() == "or" {
		p.i++
		right, ok := p.andExpr()
		if !ok {
			return value{}, false
		}
		lb, lok := left.boolean()
		rb, rok := right.boolean()
		if !lok || !rok {
			return value{}, false
		}
		left = boolVal(lb || rb)
	}
	return left, true
}

func (p *xparser) andExpr() (value, bool) {
	left, ok := p.compare()
	if !ok {
		return value{}, false
	}
	for p.peek() == "and" {
		p.i++
		right, ok := p.compare()
		if !ok {
			return value{}, false
		}
		lb, lok := left.boolean()
		rb, rok := right.boolean()
		if !lok || !rok {
			return value{}, false
		}
		left = boolVal(lb && rb)
	}
	return left, true
}

var comparators = map[string]bool{"=": true, "!=": true, "<": true, ">": true, "<=": true, ">=": true}

func (p *xparser) compare() (value, bool) {
	left, ok := p.unary()
	if !ok {
		return value{}, false
	}
	op := p.peek()
	if !comparators[op] {
		return left, true
	}
	p.i++
	right, ok := p.unary()
	if !ok {
		return value{}, false
	}
	return compareValues(op, left, right)
}

func compareValues(op string, left, right value) (value, bool) {
	switch op {
	case "=", "!=":
		// Equality over node sets is EXISTENTIAL: true when some pair matches.
		// A numeric comparison is tried first so "8080" and 8080 are the same
		// value, which is exactly the case a YAML file and a model disagree on.
		match := false
		for _, l := range left.strings() {
			for _, r := range right.strings() {
				if l == r {
					match = true
					break
				}
				lf, lok := strconv.ParseFloat(strings.TrimSpace(l), 64)
				rf, rok := strconv.ParseFloat(strings.TrimSpace(r), 64)
				if lok == nil && rok == nil && lf == rf {
					match = true
					break
				}
			}
			if match {
				break
			}
		}
		if op == "!=" {
			// XPath's "!=" over node sets is "some pair differs", not "no pair
			// matches". With one value a side - which is every case here - the
			// two agree.
			ls, rs := left.strings(), right.strings()
			if len(ls) <= 1 && len(rs) <= 1 {
				return boolVal(!match), true
			}
			differs := false
			for _, l := range ls {
				for _, r := range rs {
					if l != r {
						differs = true
					}
				}
			}
			return boolVal(differs), true
		}
		return boolVal(match), true
	default:
		lf, lok := left.number()
		rf, rok := right.number()
		if !lok || !rok {
			// A relational comparison against something that is not a number
			// is false in XPath, but it is far more likely that this evaluator
			// misread the operand - so it declines rather than refusing a
			// change on its own misreading.
			return value{}, false
		}
		switch op {
		case "<":
			return boolVal(lf < rf), true
		case ">":
			return boolVal(lf > rf), true
		case "<=":
			return boolVal(lf <= rf), true
		case ">=":
			return boolVal(lf >= rf), true
		}
	}
	return value{}, false
}

func (p *xparser) unary() (value, bool) {
	tok := p.peek()
	switch {
	case tok == "":
		return value{}, false
	case tok == "(":
		p.i++
		v, ok := p.orExpr()
		if !ok || p.peek() != ")" {
			return value{}, false
		}
		p.i++
		return v, true
	case tok == "-":
		p.i++
		v, ok := p.unary()
		if !ok {
			return value{}, false
		}
		f, isNum := v.number()
		if !isNum {
			return value{}, false
		}
		return numVal(-f), true
	case isFunctionCall(p.toks, p.i):
		return p.function()
	case isLiteral(tok):
		p.i++
		return strVal(tok[1 : len(tok)-1]), true
	case isNumber(tok):
		p.i++
		f, _ := strconv.ParseFloat(tok, 64)
		return numVal(f), true
	case isPathStart(tok):
		return p.path()
	}
	return value{}, false
}

// function evaluates the handful of XPath functions a configuration constraint
// actually uses. Anything else declines.
func (p *xparser) function() (value, bool) {
	name := p.toks[p.i]
	p.i += 2 // name and "("
	var args []value
	for p.peek() != ")" {
		if p.peek() == "" {
			return value{}, false
		}
		a, ok := p.orExpr()
		if !ok {
			return value{}, false
		}
		args = append(args, a)
		if p.peek() == "," {
			p.i++
		}
	}
	p.i++ // ")"

	switch name {
	case "true":
		return boolVal(true), len(args) == 0
	case "false":
		return boolVal(false), len(args) == 0
	case "not":
		if len(args) != 1 {
			return value{}, false
		}
		b, ok := args[0].boolean()
		return boolVal(!b), ok
	case "count":
		if len(args) != 1 || !args[0].isNode {
			return value{}, false
		}
		return numVal(float64(len(args[0].nodes))), true
	case "boolean":
		if len(args) != 1 {
			return value{}, false
		}
		b, ok := args[0].boolean()
		return boolVal(b), ok
	case "string-length":
		if len(args) != 1 {
			return value{}, false
		}
		s := args[0].strings()
		if len(s) == 0 {
			return numVal(0), true
		}
		return numVal(float64(len([]rune(s[0])))), true
	case "number":
		if len(args) != 1 {
			return value{}, false
		}
		f, ok := args[0].number()
		return numVal(f), ok
	case "starts-with", "contains":
		if len(args) != 2 {
			return value{}, false
		}
		a, b := args[0].strings(), args[1].strings()
		if len(a) == 0 || len(b) == 0 {
			return boolVal(false), true
		}
		if name == "starts-with" {
			return boolVal(strings.HasPrefix(a[0], b[0])), true
		}
		return boolVal(strings.Contains(a[0], b[0])), true
	case "current":
		if len(args) != 0 {
			return value{}, false
		}
		return nodeVal([]*Node{p.ctx.node}), true
	}
	return value{}, false
}

// path resolves a location path to the nodes it names.
func (p *xparser) path() (value, bool) {
	tok := p.toks[p.i]
	p.i++
	nodes, ok := resolvePath(p.ctx, tok)
	if !ok {
		return value{}, false
	}
	return nodeVal(nodes), true
}

// ---- path resolution ----------------------------------------------------

// resolvePath walks a location path from the evaluation context.
//
// Predicates are STRIPPED rather than evaluated: "interface[name='eth0']/mtu"
// resolves to every interface's mtu. That widens a node set, which for the
// comparisons this subset supports can only turn a refusal into a pass -
// never a pass into a refusal. Widening in that direction is the safe error to
// make; the other one refuses correct changes.
func resolvePath(ctx evalContext, path string) ([]*Node, bool) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, false
	}
	var cur []*Node
	if strings.HasPrefix(path, "/") {
		cur = []*Node{ctx.root}
		path = strings.TrimPrefix(path, "/")
	} else {
		cur = []*Node{ctx.node}
		ancestors := append([]*Node{}, ctx.ancestry...)
		for {
			switch {
			case strings.HasPrefix(path, "../"):
				path = strings.TrimPrefix(path, "../")
			case path == "..":
				path = ""
			case strings.HasPrefix(path, "./"):
				path = strings.TrimPrefix(path, "./")
				continue
			case path == ".":
				return cur, true
			default:
				goto walk
			}
			if len(ancestors) == 0 {
				// Walked out of the tree this file holds. A datastore has one
				// tree; a repository has files, and this is not an error - it
				// is a question this file cannot answer.
				return nil, false
			}
			cur = []*Node{ancestors[len(ancestors)-1]}
			ancestors = ancestors[:len(ancestors)-1]
			if path == "" {
				return cur, true
			}
		}
	}
walk:
	for _, step := range strings.Split(path, "/") {
		step = strings.TrimSpace(step)
		if i := strings.IndexByte(step, '['); i >= 0 {
			step = step[:i]
		}
		step = bare(strings.TrimPrefix(step, "@"))
		if step == "" || step == "." {
			continue
		}
		if step == ".." {
			return nil, false // a ".." mid-path needs parent links this tree has not got
		}
		var next []*Node
		for _, n := range cur {
			for _, c := range children(n) {
				if strings.EqualFold(c.Name, step) {
					// A matched repeated node contributes its ENTRIES, which is
					// how a datastore addresses a list: "count(./neighbour)"
					// counts neighbours, not the one node holding them.
					next = append(next, expand(c)...)
				}
			}
		}
		cur = next
	}
	return cur, true
}

// expand flattens a repeated node to its entries, so a path step lands on the
// entries rather than on the collection holding them - which is how a
// datastore addresses a list, and what makes "count(./neighbour)" count
// neighbours rather than the one node holding them.
func expand(n *Node) []*Node {
	if n == nil {
		return nil
	}
	if n.Repeated {
		return n.Entries
	}
	return []*Node{n}
}

// children returns the addressable children of a node, entries included.
func children(n *Node) []*Node {
	if n == nil {
		return nil
	}
	var out []*Node
	for _, e := range expand(n) {
		out = append(out, e.Children...)
	}
	return out
}

// resolveWithin resolves a descendant route ("name", "a/b") inside one node,
// which is the shape a "unique" statement names its leaves with.
func resolveWithin(n *Node, route string) *Node {
	cur := n
	for _, step := range strings.Split(route, "/") {
		step = bare(strings.TrimSpace(step))
		if step == "" || step == "." {
			continue
		}
		var found *Node
		for _, c := range children(cur) {
			if strings.EqualFold(c.Name, step) {
				found = c
				break
			}
		}
		if found == nil {
			return nil
		}
		cur = found
	}
	return cur
}

// leafrefValues collects the values a leafref path points at. The second result
// is false when the route leaves the part of the tree this file holds, which is
// the caller's cue to say nothing at all.
func leafrefValues(root *Node, ancestry []*Node, node *Node, path string) ([]any, bool) {
	nodes, ok := resolvePath(evalContext{root: root, node: node, ancestry: ancestry}, path)
	if !ok {
		return nil, false
	}
	var out []any
	for _, n := range nodes {
		for _, e := range expand(n) {
			if e.Leaf() {
				out = append(out, e.Scalar)
			}
		}
	}
	return out, true
}

// ---- lexer --------------------------------------------------------------

// lex splits an expression into tokens. A character it does not recognize
// fails the whole expression rather than being skipped: a token silently
// dropped changes what the expression means.
func lex(expr string) ([]string, bool) {
	var out []string
	i := 0
	for i < len(expr) {
		c := expr[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '\'' || c == '"':
			end := strings.IndexByte(expr[i+1:], c)
			if end < 0 {
				return nil, false
			}
			out = append(out, expr[i:i+end+2])
			i += end + 2
		case c == '(' || c == ')' || c == ',':
			out = append(out, string(c))
			i++
		case c == '!' && i+1 < len(expr) && expr[i+1] == '=':
			out = append(out, "!=")
			i += 2
		case (c == '<' || c == '>') && i+1 < len(expr) && expr[i+1] == '=':
			out = append(out, expr[i:i+2])
			i += 2
		case c == '<' || c == '>' || c == '=':
			out = append(out, string(c))
			i++
		case c == '-' && (len(out) == 0 || !isOperand(out[len(out)-1])):
			out = append(out, "-")
			i++
		case c >= '0' && c <= '9':
			j := i
			for j < len(expr) && (expr[j] >= '0' && expr[j] <= '9' || expr[j] == '.') {
				j++
			}
			out = append(out, expr[i:j])
			i = j
		case isNameStart(c) || c == '/' || c == '.' || c == '@' || c == '*':
			j := i
			depth := 0
			for j < len(expr) {
				ch := expr[j]
				if ch == '[' {
					depth++
				} else if ch == ']' {
					depth--
				} else if depth == 0 && !isPathChar(ch) {
					break
				}
				j++
			}
			out = append(out, expr[i:j])
			i = j
		default:
			return nil, false
		}
	}
	return out, true
}

func isOperand(tok string) bool {
	if tok == ")" {
		return true
	}
	return isLiteral(tok) || isNumber(tok) || isPathStart(tok)
}

func isNameStart(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '_'
}

func isPathChar(c byte) bool {
	return isNameStart(c) || c >= '0' && c <= '9' ||
		c == '/' || c == '.' || c == '-' || c == ':' || c == '@' || c == '*'
}

func isLiteral(tok string) bool {
	return len(tok) >= 2 && (tok[0] == '\'' || tok[0] == '"') && tok[len(tok)-1] == tok[0]
}

func isNumber(tok string) bool {
	if tok == "" {
		return false
	}
	_, err := strconv.ParseFloat(tok, 64)
	return err == nil
}

// isPathStart distinguishes a location path from a keyword. "and", "or" and
// "not" look exactly like a one-step path, which is the classic way an XPath
// lexer goes wrong.
func isPathStart(tok string) bool {
	switch tok {
	case "", "and", "or", "not", "div", "mod":
		return false
	}
	c := tok[0]
	return isNameStart(c) || c == '/' || c == '.' || c == '@' || c == '*'
}

// isFunctionCall reports whether the token at i is a name followed by "(".
func isFunctionCall(toks []string, i int) bool {
	if i+1 >= len(toks) || toks[i+1] != "(" {
		return false
	}
	tok := toks[i]
	if tok == "" || strings.ContainsAny(tok, "/.@*") {
		return false
	}
	return isNameStart(tok[0])
}
