package yangschema

// Identities are YANG's extensible enumerations. A module declares an identity,
// other modules derive from it, and a leaf of type "identityref { base X; }"
// may hold any identity derived from X - directly or through a chain, and quite
// possibly declared in a file the leaf's own module has never mentioned.
//
// Read only as "a string", such a leaf gets no allowed values at all, which is
// the single most useful thing the schema knew about it. Resolved here, it
// becomes an ordinary list of choices the editor can offer and the write path
// can enforce.

import "strings"

// identities indexes every identity in a module set by its bare name, together
// with the identities each one derives FROM. A YANG identity may declare
// several bases (RFC 7950 allows more than one), so this is a list rather than
// a single parent.
type identities struct {
	bases map[string][]string
	// prefixed remembers the module prefix an identity was declared with, so a
	// value can be offered in the spelling a document would use.
	declared map[string]bool
}

func newIdentities() *identities {
	return &identities{bases: map[string][]string{}, declared: map[string]bool{}}
}

// collect records every identity statement in one module's tree.
func (ids *identities) collect(st *Statement) {
	for _, sub := range st.Sub {
		if sub.Name() == "identity" && sub.Arg != "" {
			name := bare(sub.Arg)
			ids.declared[name] = true
			for _, b := range sub.Children("base") {
				if b.Arg != "" {
					ids.bases[name] = appendUnique(ids.bases[name], bare(b.Arg))
				}
			}
			// An identity with no base is a root; recording it as declared is
			// what lets a derived one find it.
			continue
		}
		ids.collect(sub)
	}
}

// derivedFrom returns every identity that derives from base, transitively,
// sorted by declaration-independent name order so the offered values are
// stable between runs. The base itself is NOT included: RFC 7950 allows an
// abstract base to be used as a value, but a base declared purely to be
// derived from is far more common, and offering it as a choice invites
// somebody to select the category instead of the thing.
func (ids *identities) derivedFrom(base string) []string {
	base = bare(base)
	if base == "" || len(ids.bases) == 0 {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	// Walk outward from the base rather than testing every identity against it:
	// a real model set holds thousands of identities and a handful of levels.
	children := map[string][]string{}
	for name, parents := range ids.bases {
		for _, p := range parents {
			children[p] = append(children[p], name)
		}
	}
	var walk func(string, int)
	walk = func(name string, depth int) {
		if depth > maxDepth {
			return
		}
		for _, child := range children[name] {
			if seen[child] {
				continue
			}
			seen[child] = true
			out = append(out, child)
			walk(child, depth+1)
		}
	}
	walk(base, 0)
	sortStrings(out)
	return out
}

// features is the set of YANG features a validation run treats as enabled.
//
// A node under "if-feature" only exists when its feature is on, and NOTHING in
// a repository says which features a given deployment built with. So the
// default is to treat every feature as ON: a rule attached to a node that turns
// out not to exist costs a warning on a setting nobody set, while dropping the
// node costs every rule on a setting somebody is editing right now. The
// asymmetry is the whole argument.
//
// A deployment that knows better lists its features explicitly (see
// LoadOptions.Features) and then the gate is real.
type features struct {
	// known is nil when every feature counts as enabled.
	known map[string]bool
}

func (f features) enabled(expr string) bool {
	if f.known == nil {
		return true
	}
	return f.evalExpr(strings.TrimSpace(expr))
}

// evalExpr reads YANG 1.1's if-feature grammar: names combined with "and",
// "or", "not" and parentheses. An expression this cannot read counts as
// enabled, for the same reason the default does.
func (f features) evalExpr(expr string) bool {
	toks := featureTokens(expr)
	if len(toks) == 0 {
		return true
	}
	p := &featureParser{toks: toks, f: f}
	v := p.or()
	if p.i != len(p.toks) {
		return true // unread tail: not understood, so not enforced
	}
	return v
}

type featureParser struct {
	toks []string
	i    int
	f    features
}

func (p *featureParser) peek() string {
	if p.i < len(p.toks) {
		return p.toks[p.i]
	}
	return ""
}

func (p *featureParser) or() bool {
	v := p.and()
	for p.peek() == "or" {
		p.i++
		v = p.and() || v
	}
	return v
}

func (p *featureParser) and() bool {
	v := p.unary()
	for p.peek() == "and" {
		p.i++
		v = p.unary() && v
	}
	return v
}

func (p *featureParser) unary() bool {
	switch t := p.peek(); {
	case t == "not":
		p.i++
		return !p.unary()
	case t == "(":
		p.i++
		v := p.or()
		if p.peek() == ")" {
			p.i++
		}
		return v
	case t == "" || t == ")":
		return true
	default:
		p.i++
		return p.f.known[bare(t)]
	}
}

func featureTokens(expr string) []string {
	var out []string
	var cur strings.Builder
	flush := func() {
		if cur.Len() > 0 {
			out = append(out, cur.String())
			cur.Reset()
		}
	}
	for _, r := range expr {
		switch r {
		case '(', ')':
			flush()
			out = append(out, string(r))
		case ' ', '\t', '\n', '\r':
			flush()
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	return out
}

func appendUnique(list []string, s string) []string {
	for _, v := range list {
		if v == s {
			return list
		}
	}
	return append(list, s)
}

// sortStrings sorts in place without pulling "sort" into every file that needs
// a stable list.
func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
