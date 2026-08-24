package yangschema

import (
	"fmt"
	"strings"
)

// Statement is one YANG statement: a keyword, an optional argument, and the
// statements nested inside it. The whole language is that shape, extensions
// included, so parsing to this tree first means an unknown keyword (a vendor
// extension nobody has taught us about) is carried rather than refused.
type Statement struct {
	Keyword string
	Arg     string
	Sub     []*Statement
}

// Prefix returns the module prefix a keyword is qualified with ("alu" in
// "alu:label"), empty for a core YANG keyword.
func (s *Statement) Prefix() string {
	if i := strings.IndexByte(s.Keyword, ':'); i > 0 {
		return s.Keyword[:i]
	}
	return ""
}

// Name returns the keyword without its module prefix.
func (s *Statement) Name() string {
	if i := strings.IndexByte(s.Keyword, ':'); i > 0 {
		return s.Keyword[i+1:]
	}
	return s.Keyword
}

// Child returns the first nested statement with any of the given unprefixed
// keywords.
func (s *Statement) Child(names ...string) *Statement {
	for _, sub := range s.Sub {
		for _, n := range names {
			if sub.Name() == n {
				return sub
			}
		}
	}
	return nil
}

// ChildArg returns the argument of the first nested statement with any of the
// given unprefixed keywords, empty when absent.
func (s *Statement) ChildArg(names ...string) string {
	if c := s.Child(names...); c != nil {
		return c.Arg
	}
	return ""
}

// Children returns every nested statement with any of the given unprefixed
// keywords.
func (s *Statement) Children(names ...string) []*Statement {
	var out []*Statement
	for _, sub := range s.Sub {
		for _, n := range names {
			if sub.Name() == n {
				out = append(out, sub)
				break
			}
		}
	}
	return out
}

// Parse reads a YANG document into its statement tree.
func Parse(src []byte) (*Statement, error) {
	p := &parser{src: string(src)}
	p.skip()
	st, err := p.statement()
	if err != nil {
		return nil, err
	}
	return st, nil
}

type parser struct {
	src string
	i   int
}

// maxDepth stops a malformed or hostile document from recursing without end.
// Real YANG nests a dozen levels at the outside.
const maxDepth = 128

func (p *parser) statement() (*Statement, error) { return p.statementAt(0) }

func (p *parser) statementAt(depth int) (*Statement, error) {
	if depth > maxDepth {
		return nil, fmt.Errorf("statements nested too deeply")
	}
	kw := p.token()
	if kw == "" {
		return nil, fmt.Errorf("expected a keyword at offset %d", p.i)
	}
	st := &Statement{Keyword: kw}
	p.skip()
	if p.at('{') || p.at(';') {
		// A statement with no argument ("input {", "mandatory;" is invalid but
		// vendor extensions do write bare "alu:free-id;").
	} else {
		arg, err := p.argument()
		if err != nil {
			return nil, err
		}
		st.Arg = arg
		p.skip()
	}
	switch {
	case p.at(';'):
		p.i++
	case p.at('{'):
		p.i++
		for {
			p.skip()
			if p.i >= len(p.src) {
				return nil, fmt.Errorf("unterminated block")
			}
			if p.at('}') {
				p.i++
				break
			}
			sub, err := p.statementAt(depth + 1)
			if err != nil {
				return nil, err
			}
			st.Sub = append(st.Sub, sub)
		}
	default:
		return nil, fmt.Errorf("expected ';' or '{' after %q at offset %d", kw, p.i)
	}
	return st, nil
}

// argument reads a YANG argument: one or more string pieces joined by "+".
// Double-quoted pieces carry escapes, single-quoted pieces are literal, and an
// unquoted piece runs to the next delimiter.
func (p *parser) argument() (string, error) {
	var b strings.Builder
	for {
		piece, err := p.stringPiece()
		if err != nil {
			return "", err
		}
		b.WriteString(piece)
		save := p.i
		p.skip()
		if p.at('+') {
			p.i++
			p.skip()
			continue
		}
		p.i = save
		return b.String(), nil
	}
}

func (p *parser) stringPiece() (string, error) {
	if p.i >= len(p.src) {
		return "", fmt.Errorf("expected an argument")
	}
	q := p.src[p.i]
	if q != '"' && q != '\'' {
		return p.token(), nil
	}
	p.i++
	var b strings.Builder
	for p.i < len(p.src) {
		c := p.src[p.i]
		if c == q {
			p.i++
			return b.String(), nil
		}
		// Only a double-quoted string processes escapes, and only the four the
		// language defines. Anything else keeps its backslash, which is what
		// makes "\\S" in a pattern come back as the regex "\S".
		if c == '\\' && q == '"' && p.i+1 < len(p.src) {
			switch p.src[p.i+1] {
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			case '"':
				b.WriteByte('"')
			case '\\':
				b.WriteByte('\\')
			default:
				b.WriteByte('\\')
				b.WriteByte(p.src[p.i+1])
			}
			p.i += 2
			continue
		}
		b.WriteByte(c)
		p.i++
	}
	return "", fmt.Errorf("unterminated string")
}

// token reads an unquoted run up to the next delimiter.
func (p *parser) token() string {
	start := p.i
	for p.i < len(p.src) {
		c := p.src[p.i]
		if c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == ';' || c == '{' || c == '}' {
			break
		}
		// A comment ends an unquoted token; "//" inside one would otherwise
		// swallow the rest of the line.
		if c == '/' && p.i+1 < len(p.src) && (p.src[p.i+1] == '/' || p.src[p.i+1] == '*') {
			break
		}
		p.i++
	}
	return p.src[start:p.i]
}

func (p *parser) at(c byte) bool { return p.i < len(p.src) && p.src[p.i] == c }

// skip advances past whitespace and comments.
func (p *parser) skip() {
	for p.i < len(p.src) {
		c := p.src[p.i]
		if c == ' ' || c == '\t' || c == '\r' || c == '\n' {
			p.i++
			continue
		}
		if c == '/' && p.i+1 < len(p.src) {
			switch p.src[p.i+1] {
			case '/':
				for p.i < len(p.src) && p.src[p.i] != '\n' {
					p.i++
				}
				continue
			case '*':
				end := strings.Index(p.src[p.i+2:], "*/")
				if end < 0 {
					p.i = len(p.src)
					return
				}
				p.i += 2 + end + 2
				continue
			}
		}
		return
	}
}
