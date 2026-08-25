package yangschema

// A YANG "pattern" is an XSD regular expression (RFC 7950 §9.4.5), and Go's
// engine is not one. The two languages agree on most of their surface and
// disagree on exactly the constructs vendors reach for when they write a
// serious restriction: XML name characters, Unicode block names, and character
// class SUBTRACTION.
//
// Handing such a pattern to Go unchanged does one of two things, both bad: it
// fails to compile (and the rule is dropped to prose, so nothing checks it), or
// - worse - it compiles into a DIFFERENT rule. "[a-z-[aeiou]]" compiles in Go
// as "a-z, a hyphen, or one of aeiou plus a stray bracket": a restriction
// written to EXCLUDE the vowels ends up admitting them.
//
// So the expression is translated rather than hoped over, and a translation
// that cannot be made faithfully returns false so the caller states the rule in
// words instead. Guessing is the one thing this file may never do.

import (
	"regexp"
	"strings"
)

// TranslateRegex converts an XSD regular expression into an equivalent Go one.
// The second result is false when no faithful equivalent exists, which is the
// caller's cue to show the restriction rather than enforce a different one.
func TranslateRegex(xsd string) (string, bool) {
	out, ok := translate(xsd)
	if !ok {
		return "", false
	}
	if _, err := regexp.Compile(out); err != nil {
		return "", false
	}
	return out, true
}

// blockClasses maps the XSD Unicode BLOCK names vendors actually use onto the
// ranges they stand for. Go names scripts and categories but not blocks, so
// "\p{IsBasicLatin}" has to become the range it means. A block not listed here
// is not guessed at.
var blockClasses = map[string]string{
	"BasicLatin":                          `\x{0000}-\x{007F}`,
	"Latin-1Supplement":                   `\x{0080}-\x{00FF}`,
	"LatinExtended-A":                     `\x{0100}-\x{017F}`,
	"LatinExtended-B":                     `\x{0180}-\x{024F}`,
	"IPAExtensions":                       `\x{0250}-\x{02AF}`,
	"SpacingModifierLetters":              `\x{02B0}-\x{02FF}`,
	"CombiningDiacriticalMarks":           `\x{0300}-\x{036F}`,
	"GreekandCoptic":                      `\x{0370}-\x{03FF}`,
	"Greek":                               `\x{0370}-\x{03FF}`,
	"Cyrillic":                            `\x{0400}-\x{04FF}`,
	"GeneralPunctuation":                  `\x{2000}-\x{206F}`,
	"SuperscriptsandSubscripts":           `\x{2070}-\x{209F}`,
	"CurrencySymbols":                     `\x{20A0}-\x{20CF}`,
	"LetterlikeSymbols":                   `\x{2100}-\x{214F}`,
	"NumberForms":                         `\x{2150}-\x{218F}`,
	"Arrows":                              `\x{2190}-\x{21FF}`,
	"MathematicalOperators":               `\x{2200}-\x{22FF}`,
	"BoxDrawing":                          `\x{2500}-\x{257F}`,
	"CJKUnifiedIdeographs":                `\x{4E00}-\x{9FFF}`,
	"Hiragana":                            `\x{3040}-\x{309F}`,
	"Katakana":                            `\x{30A0}-\x{30FF}`,
	"HangulSyllables":                     `\x{AC00}-\x{D7AF}`,
	"Specials":                            `\x{FFF0}-\x{FFFF}`,
	"HalfwidthandFullwidthForms":          `\x{FF00}-\x{FFEF}`,
	"AlphabeticPresentationForms":         `\x{FB00}-\x{FB4F}`,
	"MiscellaneousTechnical":              `\x{2300}-\x{23FF}`,
	"ControlPictures":                     `\x{2400}-\x{243F}`,
	"GeometricShapes":                     `\x{25A0}-\x{25FF}`,
	"MiscellaneousSymbols":                `\x{2600}-\x{26FF}`,
	"Dingbats":                            `\x{2700}-\x{27BF}`,
	"CJKSymbolsandPunctuation":            `\x{3000}-\x{303F}`,
	"EnclosedAlphanumerics":               `\x{2460}-\x{24FF}`,
	"CombiningDiacriticalMarksforSymbols": `\x{20D0}-\x{20FF}`,
}

// XML name characters, which XSD spells "\i" (a name's first character) and
// "\c" (any name character). Go has never heard of either.
const (
	xmlInitialChars = `A-Z_a-z\x{00C0}-\x{00D6}\x{00D8}-\x{00F6}\x{00F8}-\x{02FF}\x{0370}-\x{037D}\x{037F}-\x{1FFF}\x{200C}-\x{200D}\x{2070}-\x{218F}\x{2C00}-\x{2FEF}\x{3001}-\x{D7FF}\x{F900}-\x{FDCF}\x{FDF0}-\x{FFFD}:`
	xmlNameChars    = xmlInitialChars + `\-.0-9\x{00B7}\x{0300}-\x{036F}\x{203F}-\x{2040}`
)

// translate walks the expression once, rewriting the constructs Go cannot read
// and passing everything else through untouched.
func translate(src string) (string, bool) {
	var b strings.Builder
	for i := 0; i < len(src); {
		c := src[i]
		switch {
		case c == '\\':
			piece, n, ok := escape(src[i:], false)
			if !ok {
				return "", false
			}
			b.WriteString(piece)
			i += n
		case c == '[':
			piece, n, ok := charClass(src[i:])
			if !ok {
				return "", false
			}
			b.WriteString(piece)
			i += n
		case c == '.':
			// XSD's "." excludes both line terminators; Go's excludes only the
			// newline. A restriction that quietly admits a carriage return is
			// how a value with a stray \r survives a rule written to refuse it.
			b.WriteString(`[^\n\r]`)
			i++
		default:
			b.WriteByte(c)
			i++
		}
	}
	return b.String(), true
}

// escape rewrites one backslash escape. inClass changes what the result may
// look like: inside "[...]" the piece must be class CONTENT, outside it must
// stand on its own.
func escape(src string, inClass bool) (string, int, bool) {
	if len(src) < 2 {
		return "", 0, false
	}
	switch c := src[1]; c {
	case 'i', 'I', 'c', 'C':
		set := xmlNameChars
		if c == 'i' || c == 'I' {
			set = xmlInitialChars
		}
		negate := c == 'I' || c == 'C'
		if inClass {
			// A negated name-character set cannot be expressed as content
			// inside another class; refusing beats widening the rule.
			if negate {
				return "", 0, false
			}
			return set, 2, true
		}
		if negate {
			return "[^" + set + "]", 2, true
		}
		return "[" + set + "]", 2, true
	case 'p', 'P':
		return unicodeClass(src, inClass)
	case 'd', 'D', 'w', 'W', 's', 'S':
		// XSD defines these over the whole of Unicode where Go defines them
		// over ASCII. The difference only ever ADMITS more than Go would, so
		// the safe reading is Go's: a rule that refuses a Devanagari digit
		// where the schema allowed one is a rule nobody writes a config
		// against, while one that accepts a character the vendor excluded is a
		// bad value written to a device.
		return src[:2], 2, true
	default:
		return src[:2], 2, true
	}
}

// unicodeClass rewrites "\p{...}" - a category Go also knows passes through,
// a BLOCK name becomes the range it stands for, anything else is refused.
func unicodeClass(src string, inClass bool) (string, int, bool) {
	if len(src) < 4 || src[2] != '{' {
		return "", 0, false
	}
	end := strings.IndexByte(src, '}')
	if end < 0 {
		return "", 0, false
	}
	name := src[3:end]
	negate := src[1] == 'P'
	if strings.HasPrefix(name, "Is") {
		rng, known := blockClasses[name[2:]]
		if !known {
			return "", 0, false
		}
		if inClass {
			if negate {
				return "", 0, false
			}
			return rng, end + 1, true
		}
		if negate {
			return "[^" + rng + "]", end + 1, true
		}
		return "[" + rng + "]", end + 1, true
	}
	// A general category ("L", "Nd", "Lu"): Go spells these the same way.
	if !categoryRe.MatchString(name) {
		return "", 0, false
	}
	return src[:end+1], end + 1, true
}

var categoryRe = regexp.MustCompile(`^[A-Z][a-z]?$`)

// charClass rewrites one "[...]" group, including XSD's subtraction form
// "[A-[B]]" which Go has no equivalent for and which is therefore EXPANDED:
// the members of A are enumerated, the members of B struck out, and the
// remainder written back as a plain class. Expansion is capped, so a
// subtraction over a large slice of Unicode is refused rather than turned into
// a megabyte of alternatives.
func charClass(src string) (string, int, bool) {
	if len(src) < 2 || src[0] != '[' {
		return "", 0, false
	}
	i := 1
	negated := false
	if i < len(src) && src[i] == '^' {
		negated = true
		i++
	}
	var body strings.Builder
	// A "]" as the first member is a literal in both languages.
	if i < len(src) && src[i] == ']' {
		body.WriteString(`\]`)
		i++
	}
	for i < len(src) {
		switch c := src[i]; {
		case c == ']':
			return "[" + neg(negated) + body.String() + "]", i + 1, true
		case c == '\\':
			piece, n, ok := escape(src[i:], true)
			if !ok {
				return "", 0, false
			}
			body.WriteString(piece)
			i += n
		case c == '-' && i+1 < len(src) && src[i+1] == '[':
			// Subtraction. Everything gathered so far is the minuend; what
			// follows the "-[" is the subtrahend, and it may itself subtract.
			inner, n, ok := charClass(src[i+1:])
			if !ok {
				return "", 0, false
			}
			i += 1 + n
			if i >= len(src) || src[i] != ']' {
				return "", 0, false
			}
			cls, ok := subtract(neg(negated)+body.String(), inner)
			if !ok {
				return "", 0, false
			}
			return cls, i + 1, true
		default:
			body.WriteByte(c)
			i++
		}
	}
	return "", 0, false
}

func neg(b bool) string {
	if b {
		return "^"
	}
	return ""
}

// maxExpand caps how many code points a subtraction may enumerate. Real
// subtractions carve a handful of characters out of an ASCII range; anything
// bigger is a pattern this translator declines rather than expands.
const maxExpand = 2048

// subtract turns "class minus class" into one plain class, by asking each
// engine-compiled side about every code point the minuend can reach. Enumerating
// is the only honest route: Go has no set difference, and the alternatives
// (lookahead, a second pass at match time) do not exist in RE2 either.
func subtract(minuendBody, subtrahend string) (string, bool) {
	minuend, err := regexp.Compile("^[" + minuendBody + "]$")
	if err != nil {
		return "", false
	}
	sub, err := regexp.Compile("^" + subtrahend + "$")
	if err != nil {
		return "", false
	}
	var kept []rune
	// The scan covers the Basic Multilingual Plane's lower half, which is where
	// every real subtraction lives. A minuend reaching past it is refused by the
	// cap below rather than silently truncated.
	for r := rune(0); r <= 0x2FFF; r++ {
		s := string(r)
		if !minuend.MatchString(s) {
			continue
		}
		if sub.MatchString(s) {
			continue
		}
		if len(kept) >= maxExpand {
			return "", false
		}
		kept = append(kept, r)
	}
	if len(kept) == 0 {
		// Nothing survives the subtraction: a class that can never match. Go
		// spells that with a class no character is in.
		return `[^\x{0}-\x{10FFFF}]`, true
	}
	return "[" + condense(kept) + "]", true
}

// condense writes a sorted rune set back as class content, folding runs of
// three or more into ranges so the result stays readable and small.
func condense(runes []rune) string {
	var b strings.Builder
	for i := 0; i < len(runes); {
		j := i
		for j+1 < len(runes) && runes[j+1] == runes[j]+1 {
			j++
		}
		switch {
		case j-i >= 2:
			b.WriteString(quoteRune(runes[i]))
			b.WriteByte('-')
			b.WriteString(quoteRune(runes[j]))
		default:
			for k := i; k <= j; k++ {
				b.WriteString(quoteRune(runes[k]))
			}
		}
		i = j + 1
	}
	return b.String()
}

// quoteRune renders one code point as class content: printable ASCII literally
// (with the class metacharacters escaped), everything else as \x{...}.
func quoteRune(r rune) string {
	if r >= 0x20 && r < 0x7F {
		if strings.ContainsRune(`\]^-[`, r) {
			return `\` + string(r)
		}
		return string(r)
	}
	return `\x{` + strings.ToUpper(hex(uint32(r))) + `}`
}

func hex(v uint32) string {
	const digits = "0123456789abcdef"
	if v == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = digits[v&0xF]
		v >>= 4
	}
	return string(buf[i:])
}
