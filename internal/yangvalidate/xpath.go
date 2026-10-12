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
	// approx marks a value derived from a path whose predicate was stripped
	// rather than evaluated, so the node set is a SUPERSET of the real one.
	// Widening is safe under existential equality - it can only turn a refusal
	// into a pass - and unsafe everywhere else, which is why it travels with the
	// value instead of being assumed harmless.
	approx bool
}

func (v value) with(approx bool) value { v.approx = approx; return v }

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
		left = boolVal(lb || rb).with(left.approx || right.approx)
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
		left = boolVal(lb && rb).with(left.approx || right.approx)
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
	approx := left.approx || right.approx
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
				return boolVal(!match).with(approx), true
			}
			differs := false
			for _, l := range ls {
				for _, r := range rs {
					if l != r {
						differs = true
					}
				}
			}
			return boolVal(differs).with(approx), true
		}
		return boolVal(match).with(approx), true
	default:
		if approx {
			// A relational comparison reads ONE member of a node set, and a set
			// widened by a stripped predicate may not be holding the member the
			// expression meant.
			return value{}, false
		}
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
		if len(args) != 1 || args[0].approx {
			// not() inverts the safe direction: a widened set makes the inner
			// test likelier to hold, so negating it refuses a change that is
			// probably fine.
			return value{}, false
		}
		b, ok := args[0].boolean()
		return boolVal(!b), ok
	case "count":
		if len(args) != 1 || !args[0].isNode || args[0].approx {
			// Counting a set widened by a stripped predicate counts the wrong
			// things, and "count(...) = 1" then refuses a document that
			// satisfies it.
			return value{}, false
		}
		return numVal(float64(len(args[0].nodes))), true
	case "boolean":
		if len(args) != 1 {
			return value{}, false
		}
		b, ok := args[0].boolean()
		return boolVal(b).with(args[0].approx), ok
	case "string-length":
		if len(args) != 1 || args[0].approx {
			return value{}, false
		}
		s := args[0].strings()
		if len(s) == 0 {
			return numVal(0), true
		}
		return numVal(float64(len([]rune(s[0])))), true
	case "number":
		if len(args) != 1 || args[0].approx {
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
			return boolVal(false).with(args[0].approx || args[1].approx), true
		}
		approx := args[0].approx || args[1].approx
		if name == "starts-with" {
			return boolVal(strings.HasPrefix(a[0], b[0])).with(approx), true
		}
		return boolVal(strings.Contains(a[0], b[0])).with(approx), true
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
	nodes, approx, ok := resolvePath(p.ctx, tok)
	if !ok {
		return value{}, false
	}
	return nodeVal(nodes).with(approx), true
}

// ---- path resolution ----------------------------------------------------

// resolvePath walks a location path from the evaluation context and gives
// THREE answers, not two: the nodes it names, whether that answer is
// approximate, and whether the path could be read at all.
//
// Predicates are STRIPPED rather than evaluated, which widens the node set;
// the widening is reported back as "approximate" so the operators that cannot
// survive it (count, relational comparison, negation) decline instead of
// refusing a correct change on a set they know is too big.
//
// A step this subset cannot ADDRESS - a wildcard, an axis, a node test - makes
// the whole path unreadable. It used to resolve to nothing instead, which is
// how "count(../*[current() = .]) = 1" became a refusal on every document.
func resolvePath(ctx evalContext, path string) ([]*Node, bool, bool) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, false, false
	}
	var cur []*Node
	var rest string
	approx := false

	if strings.HasPrefix(path, "/") {
		steps := strings.Split(strings.TrimPrefix(path, "/"), "/")
		name, pred, ok := stepName(steps[0])
		if !ok {
			return nil, false, false
		}
		approx = pred
		// An absolute path is written against the DATASTORE root, and a
		// repository file holds a FRAGMENT of one - routinely under a wrapper
		// element ("config", a Kubernetes envelope) the model never named. So
		// the first step is anchored wherever it actually appears, and a first
		// step that appears nowhere means this file does not hold that subtree:
		// a question it cannot answer, never a violation.
		cur = anchor(ctx.root, name)
		if len(cur) == 0 {
			return nil, false, false
		}
		rest = strings.Join(steps[1:], "/")
	} else {
		var ok bool
		cur, rest, ok = climb(ctx, path)
		if !ok {
			return nil, false, false
		}
	}

	if strings.TrimSpace(rest) == "" {
		return cur, approx, true
	}
	for _, step := range strings.Split(rest, "/") {
		name, pred, ok := stepName(step)
		if !ok {
			return nil, false, false
		}
		approx = approx || pred
		if name == "" {
			continue
		}
		var next []*Node
		for _, n := range cur {
			for _, c := range children(n) {
				if strings.EqualFold(c.Name, name) {
					// A matched repeated node contributes its ENTRIES, which is
					// how a datastore addresses a list: "count(./neighbour)"
					// counts neighbours, not the one node holding them.
					next = append(next, expand(c)...)
				}
			}
		}
		cur = next
	}
	return cur, approx, true
}

// climb walks the leading "." and ".." of a relative path and returns where the
// remaining steps start from. Walking out of the top of the tree is not an
// error: a datastore has one tree, a repository has files, and this is a
// question the file cannot answer.
func climb(ctx evalContext, path string) ([]*Node, string, bool) {
	cur := []*Node{ctx.node}
	ancestors := append([]*Node{}, ctx.ancestry...)
	for {
		switch {
		case strings.HasPrefix(path, "./"):
			path = strings.TrimPrefix(path, "./")
			continue
		case path == ".":
			return cur, "", true
		case strings.HasPrefix(path, "../"):
			path = strings.TrimPrefix(path, "../")
		case path == "..":
			path = ""
		default:
			return cur, path, true
		}
		if len(ancestors) == 0 {
			return nil, "", false
		}
		cur = []*Node{ancestors[len(ancestors)-1]}
		ancestors = ancestors[:len(ancestors)-1]
		if path == "" {
			return cur, "", true
		}
	}
}

// stepName reads one location step: the name it addresses with any module
// prefix and predicate removed, and whether it carried a predicate. The third
// result is false for a step this subset cannot address at all.
func stepName(step string) (name string, predicate bool, ok bool) {
	step = strings.TrimSpace(step)
	if i := strings.IndexByte(step, '['); i >= 0 {
		predicate = true
		step = strings.TrimSpace(step[:i])
	}
	switch step {
	case "", ".":
		return "", predicate, true
	case "*", "..":
		// A wildcard names siblings this tree can enumerate but the expression
		// around it usually cannot survive; ".." mid-path needs parent links
		// this tree has not got.
		return "", predicate, false
	}
	if strings.Contains(step, "::") || strings.Contains(step, "(") {
		// An axis ("child::x") or a node test ("text()") is not a name. A
		// module prefix ("dp:net-info") is, and bare() strips it below.
		return "", predicate, false
	}
	return bare(strings.TrimPrefix(step, "@")), predicate, true
}

// anchor finds where an absolute path's first step actually sits in this file,
// which is not necessarily at its root.
func anchor(root *Node, name string) []*Node {
	if name == "" {
		return []*Node{root}
	}
	var out []*Node
	var walk func(n *Node, depth int)
	walk = func(n *Node, depth int) {
		if n == nil || depth > maxDepth {
			return
		}
		for _, c := range children(n) {
			if strings.EqualFold(c.Name, name) {
				out = append(out, expand(c)...)
				continue
			}
			walk(c, depth+1)
		}
	}
	walk(root, 0)
	return out
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
//
// A widened set is fine here: an extra candidate can only make a reference
// resolve, never fail.
func leafrefValues(root *Node, ancestry []*Node, node *Node, path string) ([]any, bool) {
	nodes, _, ok := resolvePath(evalContext{root: root, node: node, ancestry: ancestry}, path)
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
