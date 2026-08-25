package yangschema

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// Apply writes everything a model node says onto a parameter: its data type,
// its rules, the prose that explains it, the label it is known by and the
// default the vendor shipped.
//
// The schema WINS over what discovery guessed - a range the vendor wrote down
// is a fact and a type inferred from a leaf name is a hunch - but it never
// overwrites what a PERSON wrote: a description or a display name already on
// the parameter stays, because somebody chose it.
func Apply(p *model.Parameter, n *Node) {
	if n == nil {
		return
	}
	v := &model.Validation{}
	wasList := p.Type == model.TypeList

	scalar := mapType(n, v)
	p.Type = scalar
	if n.Mandatory {
		v.Required = true
	}
	if n.Units != "" {
		v.Units = n.Units
	}
	// Operational state belongs to the device: it is worth SEEING beside the
	// settings that shape it, and writing it back would be overwritten by the
	// next read. An obsolete setting is read-only for a different reason and
	// the same effect - the vendor has withdrawn it.
	if !n.Editable() {
		v.ReadOnly = true
	}
	if n.Status == "deprecated" || n.Status == "obsolete" {
		// The version this stops being usable at is not stated by the model,
		// only that it has. The grid's version machinery wants an identifier;
		// what it gets is the truthful one the schema gave.
		if p.VersionDeprecated == "" {
			p.VersionDeprecated = n.Status
		}
	}
	if n.Kind == "leaf-list" || n.Kind == "list" {
		// A repeated node says how many entries the collection may hold - but
		// the parameter in front of us may be the COLLECTION or may be one
		// entry of it addressed by position. Rewriting a scalar into a list
		// would put a list editor in front of a single value, so the size
		// limits only become rules when the parameter really is the list, and
		// are stated in words when it is not.
		if wasList {
			p.Type, p.ItemType = model.TypeList, scalar
			v.MinItems, v.MaxItems = n.MinElements, n.MaxElements
		} else if s := describeCount(n.MinElements, n.MaxElements); s != "" {
			v.Constraints = append(v.Constraints, s)
		}
	}
	v.Constraints = append(v.Constraints, n.Constraints...)
	v.SchemaRef = n.File

	// Cross-parameter relations are the user's own (a limit bounded by its
	// request); a schema has no way to name another parameter, so they carry
	// across untouched.
	v.AtLeast, v.AtMost = p.Validation.AtLeast, p.Validation.AtMost
	p.Validation = *v

	if p.Description == "" {
		p.Description = n.Description
	}
	if p.DisplayName == "" {
		p.DisplayName = n.Label
	}
	// A schema-declared default REPLACES an inferred one. Discovery's guess is
	// "every instance currently holds the same value", which is a fact about
	// today's fleet and a poor default: create the next instance and it would
	// inherit the last one's value instead of the value the vendor ships. What
	// the model declares is the fallback the product itself was built with.
	if n.Default != "" {
		p.Default = coerceDefault(p.Type, n.Default)
	}
}

// mapType decides the parameter's data type from the model's type and fills
// the rules that type carries.
func mapType(n *Node, v *model.Validation) model.ParamType {
	t := n.Type
	if t == nil {
		return model.TypeString
	}
	// The schema's own wording for a refused value belongs to the parameter
	// whatever the restriction that refused it was.
	v.ErrorMessage = t.ErrorMessage

	// The SPELLING of the type carries meaning the builtin has thrown away:
	// "inet:ipv4-address" is a string, but a string this product knows how to
	// check, offer the right editor for, and explain a failure of.
	if pt, found := semanticTypes[strings.ToLower(bare(t.Qualified))]; found {
		applyBounds(t, v, pt)
		applyPatterns(t, v)
		return pt
	}

	switch t.Base {
	case "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64":
		applyIntegerBounds(t, v)
		return model.TypeInteger
	case "decimal64":
		applyBounds(t, v, model.TypeNumber)
		// A decimal64 is exact to a stated number of places. A value with more
		// of them is not a value the device can hold, so this is a rule and not
		// a note: "fraction-digits 2" refuses 1.005 the way the box will.
		if t.FractionDigits > 0 {
			fd := t.FractionDigits
			v.MaxDecimals = &fd
		}
		return model.TypeNumber
	case "boolean", "empty":
		return model.TypeBoolean
	case "enumeration":
		for _, e := range t.Enums {
			if e.Name != "" {
				v.Enum = append(v.Enum, e.Name)
			}
		}
		if len(v.Enum) > 0 {
			return model.TypeEnum
		}
		return model.TypeString
	case "identityref":
		// The values an identityref may hold are the identities derived from
		// its base - an ordinary list of choices, once every module has been
		// read. Left as "a string" this is the most useful thing the schema
		// knew about the setting and the one thing nothing checked.
		if len(t.Identities) > 0 {
			v.Enum = append(v.Enum, t.Identities...)
			return model.TypeEnum
		}
		if t.IdentityBase != "" {
			v.Constraints = append(v.Constraints, "an identity derived from "+t.IdentityBase)
		}
		return model.TypeString
	case "bits":
		// A flags value is a subset of the declared names. That IS checkable -
		// listing them in prose let a typo through to the device.
		if names := t.BitNames(); len(names) > 0 {
			v.Bits = names
			v.Constraints = append(v.Constraints, "any combination of: "+strings.Join(names, ", "))
		}
		return model.TypeString
	case "union":
		// A value has to satisfy ONE member, so no member's restriction can be
		// layered on the others - but the members TOGETHER are a rule, and
		// checking "any of these accepts it" refuses the values none of them
		// would. Naming the alternatives in prose refused nothing at all.
		return applyUnion(t, v)
	case "leafref":
		if t.LeafrefPath != "" {
			v.Constraints = append(v.Constraints, "must match an existing "+leafrefTail(t.LeafrefPath))
		}
		return model.TypeString
	case "instance-identifier", "binary":
		applyLengths(t, v)
		return model.TypeString
	}

	applyLengths(t, v)
	applyPatterns(t, v)
	return model.TypeString
}

// applyUnion turns a union's members into alternative rule sets, and chooses
// the parameter's own type as the WIDEST of them - which is a string unless
// every member agrees, because an editor that only accepts numbers cannot type
// the word the other member allows.
func applyUnion(t *Type, v *model.Validation) model.ParamType {
	var alts []model.Alternative
	common := model.ParamType("")
	agreed := true
	for _, m := range t.Union {
		if m == nil {
			continue
		}
		sub := &model.Validation{}
		mt := mapType(&Node{Type: m, Config: true}, sub)
		alts = append(alts, model.Alternative{
			Label: firstArg(m.Qualified, m.Base), Type: mt,
			Pattern: sub.Pattern, Patterns: sub.Patterns, NotPatterns: sub.NotPatterns,
			Enum: sub.Enum, Bits: sub.Bits, Min: sub.Min, Max: sub.Max,
			MinLength: sub.MinLength, MaxLength: sub.MaxLength,
			Ranges: sub.Ranges, Lengths: sub.Lengths,
		})
		switch {
		case common == "":
			common = mt
		case common != mt:
			agreed = false
		}
	}
	if len(alts) == 0 {
		return model.TypeString
	}
	v.AnyOf = alts
	if names := unionNames(t); names != "" {
		v.Constraints = append(v.Constraints, "one of: "+names)
	}
	if agreed && common != "" {
		// Every member is the same kind of thing (a union of two integer
		// ranges, say): the editor for that kind is the right one, and the
		// alternatives still decide what it accepts.
		return common
	}
	return model.TypeString
}

// leafrefTail words a leafref target the way a reader would say it: the last
// two steps of the route, which is what identifies the thing being pointed at
// without reciting the whole model.
func leafrefTail(path string) string {
	var steps []string
	for _, s := range strings.Split(path, "/") {
		s = strings.TrimSpace(s)
		if i := strings.IndexByte(s, '['); i >= 0 {
			s = s[:i]
		}
		if s = bare(s); s != "" && s != ".." && s != "." {
			steps = append(steps, s)
		}
	}
	if len(steps) == 0 {
		return "referenced value"
	}
	if len(steps) == 1 {
		return steps[0]
	}
	return strings.Join(steps[len(steps)-2:], " ")
}

// semanticTypes maps the standard type libraries' well-known names onto the
// product's own operational types. These are the names RFC 6991 defines, which
// every vendor imports rather than reinventing.
var semanticTypes = map[string]model.ParamType{
	"ipv4-address":         model.TypeIPv4,
	"ipv4-address-no-zone": model.TypeIPv4,
	"ipv6-address":         model.TypeIPv6,
	"ipv6-address-no-zone": model.TypeIPv6,
	"ipv4-prefix":          model.TypeCIDR,
	"ipv6-prefix":          model.TypeCIDR,
	"ip-prefix":            model.TypeCIDR,
	"port-number":          model.TypePort,
	"domain-name":          model.TypeHostname,
	"host-name":            model.TypeHostname,
	"uri":                  model.TypeURL,
	"mac-address":          model.TypeMAC,
	"phys-address":         model.TypeMAC,
}

// applyBounds fills min/max (numeric types) or length limits (everything
// else), plus patterns.
func applyBounds(t *Type, v *model.Validation, pt model.ParamType) {
	switch pt {
	case model.TypeInteger, model.TypeNumber, model.TypePort:
		applyRanges(t, v)
	default:
		applyLengths(t, v)
	}
}

func applyRanges(t *Type, v *model.Validation) {
	if len(t.Ranges) == 0 {
		return
	}
	lo, hi := Span(t.Ranges)
	v.Min, v.Max = lo, hi
	if len(t.Ranges) > 1 {
		// A single min/max cannot say "5..20 or 40..100": it accepts 30, which
		// the vendor wrote the restriction to refuse. So the real spans travel
		// too, they are what the write path checks, and the outer span stays
		// only so a reader (and an older client) still sees a range at all.
		v.Ranges = spans(t.Ranges)
		v.Constraints = append(v.Constraints, "allowed ranges: "+describeBounds(t.Ranges))
	}
}

// spans converts the schema's own bound list into the model's.
func spans(bounds []Bound) []model.Span {
	out := make([]model.Span, 0, len(bounds))
	for _, b := range bounds {
		out = append(out, model.Span{Min: b.Min, Max: b.Max})
	}
	return out
}

// applyIntegerBounds adds the width of the integer type itself when the schema
// stated no range: "uint8" IS a range, and enforcing it costs nothing.
func applyIntegerBounds(t *Type, v *model.Validation) {
	applyRanges(t, v)
	if v.Min != nil || v.Max != nil {
		return
	}
	if w, found := intWidths[t.Base]; found {
		lo, hi := w[0], w[1]
		v.Min, v.Max = &lo, &hi
	}
}

var intWidths = map[string][2]float64{
	"int8":   {-128, 127},
	"int16":  {-32768, 32767},
	"int32":  {-2147483648, 2147483647},
	"uint8":  {0, 255},
	"uint16": {0, 65535},
	"uint32": {0, 4294967295},
	// int64/uint64 are left out on purpose: their extremes do not survive the
	// float64 the rule is carried in, so stating them would be a lie.
}

func applyLengths(t *Type, v *model.Validation) {
	if len(t.Lengths) == 0 {
		return
	}
	lo, hi := Span(t.Lengths)
	if lo != nil {
		n := int(*lo)
		v.MinLength = &n
	}
	if hi != nil {
		n := int(*hi)
		v.MaxLength = &n
	}
	if len(t.Lengths) > 1 {
		v.Lengths = spans(t.Lengths)
		v.Constraints = append(v.Constraints, "allowed lengths: "+describeBounds(t.Lengths))
	}
}

// applyPatterns translates the schema's regular expressions.
//
// A YANG pattern is an XSD regular expression, which is anchored to the WHOLE
// value and speaks a dialect Go does not; both are handled by TranslateRegex.
// Every pattern in the chain must hold, which is why they do not collapse into
// one field - and an INVERTED one is a rule in its own right rather than a
// sentence, because the restriction a vendor bothered to invert was exactly the
// one nothing used to check.
//
// One that still has no faithful Go equivalent is stated in words instead of
// being enforced wrongly. Enforcing an approximation of somebody's restriction
// is the one outcome worse than not enforcing it.
func applyPatterns(t *Type, v *model.Validation) {
	for _, p := range t.Patterns {
		expr, translated := TranslateRegex(anchor(p.Regex))
		if !translated {
			if p.Invert {
				v.Constraints = append(v.Constraints, "must not match "+p.Regex)
			} else {
				v.Constraints = append(v.Constraints, "must match "+p.Regex)
			}
			continue
		}
		if p.Invert {
			if !containsString(v.NotPatterns, expr) {
				v.NotPatterns = append(v.NotPatterns, expr)
				v.Constraints = append(v.Constraints, "must not match "+p.Regex)
			}
			continue
		}
		if v.Pattern == "" {
			v.Pattern = expr
		} else if !containsString(v.Patterns, expr) && expr != v.Pattern {
			v.Patterns = append(v.Patterns, expr)
		}
		if p.ErrorMessage != "" && v.ErrorMessage == "" {
			v.ErrorMessage = p.ErrorMessage
		}
	}
}

// anchor makes an XSD expression mean the same thing to an unanchored engine.
func anchor(re string) string {
	if strings.HasPrefix(re, "^") && strings.HasSuffix(re, "$") {
		return re
	}
	return "^(?:" + re + ")$"
}

func describeBounds(bounds []Bound) string {
	parts := make([]string, 0, len(bounds))
	for _, b := range bounds {
		switch {
		case b.Min != nil && b.Max != nil && *b.Min == *b.Max:
			parts = append(parts, formatFloat(*b.Min))
		default:
			parts = append(parts, boundEnd(b.Min, "min")+".."+boundEnd(b.Max, "max"))
		}
	}
	return strings.Join(parts, ", ")
}

func boundEnd(p *float64, open string) string {
	if p == nil {
		return open
	}
	return formatFloat(*p)
}

// describeCount words the size limits of a repeated node for a parameter that
// holds one of its entries rather than the whole collection.
func describeCount(min, max *int) string {
	switch {
	case min != nil && max != nil:
		return fmt.Sprintf("the list holds %d to %d entries", *min, *max)
	case min != nil && *min > 0:
		return fmt.Sprintf("the list holds at least %d entries", *min)
	case max != nil:
		return fmt.Sprintf("the list holds at most %d entries", *max)
	}
	return ""
}

func unionNames(t *Type) string {
	names := make([]string, 0, len(t.Union))
	for _, m := range t.Union {
		if n := firstArg(m.Qualified, m.Base); n != "" {
			names = append(names, n)
		}
	}
	return strings.Join(names, ", ")
}

// coerceDefault renders a schema default in the parameter's own type, so a
// boolean default is a boolean and not the word "true".
func coerceDefault(t model.ParamType, s string) any {
	switch t {
	case model.TypeBoolean:
		if b, err := strconv.ParseBool(s); err == nil {
			return b
		}
	case model.TypeInteger, model.TypePort:
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			return n
		}
	case model.TypeNumber:
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return f
		}
	}
	return s
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func formatFloat(f float64) string {
	if f == float64(int64(f)) {
		return strconv.FormatInt(int64(f), 10)
	}
	return fmt.Sprintf("%g", f)
}
