// Package validate applies a parameter's data type and validation rules to a
// value and reports whether it is valid, with a human-readable message when
// not. Rules come from three layers: the parameter's declared type (integer,
// boolean, ipv4, ...), an optional predefined preset rule, and explicit rules
// (pattern, enum, min/max, minLength/maxLength).
package validate

import (
	"fmt"
	"math"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// Result is the outcome of validating a single value.
type Result struct {
	Valid   bool   `json:"valid"`
	Message string `json:"message,omitempty"`
}

func ok() Result                { return Result{Valid: true} }
func invalid(msg string) Result { return Result{Valid: false, Message: msg} }

var patternCache sync.Map // pattern string -> *regexp.Regexp

func compiled(pattern string) (*regexp.Regexp, error) {
	if v, hit := patternCache.Load(pattern); hit {
		return v.(*regexp.Regexp), nil
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, err
	}
	patternCache.Store(pattern, re)
	return re, nil
}

// Value validates v against param's type and rules. A nil/empty value is valid
// unless the parameter is required.
func Value(param model.Parameter, v any) Result {
	val := param.Validation
	if v == nil || v == "" {
		if val.Required {
			return invalid("value is required")
		}
		return ok()
	}

	// Lists: size rules on the collection, remaining rules per element.
	if param.Type == model.TypeList {
		items, isList := v.([]any)
		if !isList {
			return invalid("expected a list")
		}
		if val.MinItems != nil && len(items) < *val.MinItems {
			return invalid(fmt.Sprintf("fewer than %d entries", *val.MinItems))
		}
		if val.MaxItems != nil && len(items) > *val.MaxItems {
			return invalid(fmt.Sprintf("more than %d entries", *val.MaxItems))
		}
		itemParam := param
		itemParam.Type = param.ItemType
		if itemParam.Type == "" {
			itemParam.Type = model.TypeString
		}
		itemParam.Validation.MinItems, itemParam.Validation.MaxItems = nil, nil
		itemParam.Validation.Required = false
		for i, it := range items {
			if r := Value(itemParam, it); !r.Valid {
				return invalid(fmt.Sprintf("entry %d: %s", i+1, r.Message))
			}
		}
		return ok()
	}

	// Layer 0: a union is checked whole, before anything else. Its members
	// disagree about what the value even IS, so no rule below can speak for all
	// of them - and the parameter's own type is the widest of them, chosen so an
	// editor exists at all.
	if len(val.AnyOf) > 0 {
		if r := Alternatives(val.AnyOf, v); !r.Valid {
			if val.ErrorMessage != "" {
				return invalid(val.ErrorMessage)
			}
			return r
		}
		return ok()
	}

	// Layer 1: the declared data type must hold.
	if r := checkType(param.Type, v); !r.Valid {
		return r
	}
	s := fmt.Sprintf("%v", v)

	// Layer 2: the referenced preset rule, if any. Failures speak in the
	// preset's human name with an example, never in regex.
	if val.Preset != "" {
		if p, found := PresetByID(val.Preset); found {
			rules := model.Validation{
				Pattern: p.Pattern, Min: p.Min, Max: p.Max,
				MinLength: p.MinLength, MaxLength: p.MaxLength,
			}
			// The preset's failure is worded by the preset, so the parameter's
			// own message must not be borrowed for it.

			if r := applyRules(rules, s); !r.Valid {
				msg := p.Name + ": " + r.Message
				if p.Example != "" {
					msg += ", for example " + p.Example
				}
				return invalid(msg)
			}
		}
	}

	// Layer 3: explicit rules on the parameter.
	return applyRules(val, s)
}

// Alternatives checks a value against a set of alternative rule sets (a schema
// union): it is valid when at least ONE alternative accepts it.
//
// A union cannot be checked by layering its members' rules on top of each
// other - "either a number in 1..100 or the word auto" would then refuse both
// legitimate spellings. So each alternative is checked whole and independently,
// and only a value no alternative accepts is refused. The rejection names the
// alternatives rather than the last one's arithmetic, because "above maximum
// 100" is a lie about a value that was allowed to be a word.
func Alternatives(alts []model.Alternative, v any) Result {
	if len(alts) == 0 {
		return ok()
	}
	labels := make([]string, 0, len(alts))
	for _, alt := range alts {
		t := alt.Type
		if t == "" {
			t = model.TypeString
		}
		if r := checkType(t, v); !r.Valid {
			labels = appendLabel(labels, alt, t)
			continue
		}
		if r := applyRules(alt.Rules(), fmt.Sprintf("%v", v)); !r.Valid {
			labels = appendLabel(labels, alt, t)
			continue
		}
		return ok()
	}
	return invalid("must be one of: " + strings.Join(labels, ", "))
}

func appendLabel(labels []string, alt model.Alternative, t model.ParamType) []string {
	label := alt.Label
	if label == "" {
		label = string(t)
	}
	for _, existing := range labels {
		if existing == label {
			return labels
		}
	}
	return append(labels, label)
}

// CoerceValue converts a raw (typically JSON-decoded) value into the
// canonical Go type for the parameter, handling lists by coercing each
// element to the item type. Used by the write path before validation.
func CoerceValue(param model.Parameter, v any) (any, error) {
	if param.Type != model.TypeList {
		return Coerce(param.Type, v)
	}
	items, isList := v.([]any)
	if !isList {
		return nil, fmt.Errorf("expected a list")
	}
	itemType := param.ItemType
	if itemType == "" {
		itemType = model.TypeString
	}
	out := make([]any, len(items))
	for i, it := range items {
		c, err := Coerce(itemType, it)
		if err != nil {
			return nil, fmt.Errorf("entry %d: %w", i+1, err)
		}
		out[i] = c
	}
	return out, nil
}

// Coerce converts a raw (typically JSON-decoded) value into the canonical Go
// type for the parameter's declared type, or returns an error if it cannot
// represent that type. Used by the write path before validation.
func Coerce(t model.ParamType, v any) (any, error) {
	switch t {
	case model.TypeInteger, model.TypePort:
		switch n := v.(type) {
		case int:
			return int64(n), nil
		case int64:
			return n, nil
		case float64:
			if n != math.Trunc(n) {
				return nil, fmt.Errorf("expected an integer")
			}
			return int64(n), nil
		case string:
			i, err := strconv.ParseInt(strings.TrimSpace(n), 10, 64)
			if err != nil {
				return nil, fmt.Errorf("expected an integer")
			}
			return i, nil
		}
		return nil, fmt.Errorf("expected an integer")
	case model.TypeNumber:
		switch n := v.(type) {
		case float64:
			return n, nil
		case int:
			return float64(n), nil
		case int64:
			return float64(n), nil
		case string:
			f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
			if err != nil {
				return nil, fmt.Errorf("expected a number")
			}
			return f, nil
		}
		return nil, fmt.Errorf("expected a number")
	case model.TypeBoolean:
		switch b := v.(type) {
		case bool:
			return b, nil
		case string:
			if b == "true" {
				return true, nil
			}
			if b == "false" {
				return false, nil
			}
		}
		return nil, fmt.Errorf("expected a boolean")
	default:
		return v, nil
	}
}

// checkType verifies that v is representable as the declared type.
func checkType(t model.ParamType, v any) Result {
	if r, handled := checkQuantityType(t, v); handled {
		return r
	}
	switch t {
	case model.TypeInteger, model.TypeNumber, model.TypeBoolean:
		if _, err := Coerce(t, v); err != nil {
			return invalid(err.Error())
		}
	case model.TypeIPv4:
		s := fmt.Sprintf("%v", v)
		ip := net.ParseIP(s)
		if ip == nil || ip.To4() == nil {
			return invalid("must be a valid IPv4 address")
		}
	case model.TypeIPv6:
		s := fmt.Sprintf("%v", v)
		ip := net.ParseIP(s)
		// A valid IPv6 literal parses and is not an IPv4 address.
		if ip == nil || ip.To4() != nil || !strings.Contains(s, ":") {
			return invalid("must be a valid IPv6 address")
		}
	case model.TypeCIDR:
		if _, _, err := net.ParseCIDR(fmt.Sprintf("%v", v)); err != nil {
			return invalid("must be a valid CIDR block")
		}
	case model.TypePort:
		n, err := strconv.Atoi(strings.TrimSpace(fmt.Sprintf("%v", v)))
		if err != nil || n < 1 || n > 65535 {
			return invalid("must be a port number between 1 and 65535")
		}
	case model.TypeHostname:
		if !hostnameRe.MatchString(fmt.Sprintf("%v", v)) {
			return invalid("must be a valid hostname")
		}
	case model.TypeEmail:
		if !emailRe.MatchString(fmt.Sprintf("%v", v)) {
			return invalid("must be a valid email address")
		}
	case model.TypeURL:
		s := fmt.Sprintf("%v", v)
		if u, err := url.Parse(s); err != nil || u.Scheme == "" || u.Host == "" {
			return invalid("must be a valid URL (including scheme, e.g. https://…)")
		}
	case model.TypeMAC:
		if _, err := net.ParseMAC(fmt.Sprintf("%v", v)); err != nil {
			return invalid("must be a valid MAC address")
		}
	}
	return ok()
}

// Format helpers for the operational scalar types. Kept deliberately practical
// rather than RFC-exhaustive: they catch the mistakes people actually make.
var (
	hostnameRe = regexp.MustCompile(`^(?i)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)
	emailRe    = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
)

// applyRules enforces the explicit rule fields against the value's string form.
func applyRules(val model.Validation, s string) Result {
	// Every pattern must hold, not just the first: a schema restricts a value
	// through a chain of definitions and a value has to satisfy all of them.
	// A rejection speaks in the schema's OWN words when it gave any, because
	// "doesn't match the required format" tells the reader nothing they can act
	// on and a regular expression tells them less.
	for _, pattern := range append([]string{val.Pattern}, val.Patterns...) {
		if pattern == "" {
			continue
		}
		re, err := compiled(pattern)
		if err != nil {
			return invalid("invalid validation pattern")
		}
		if !re.MatchString(s) {
			if val.ErrorMessage != "" {
				return invalid(val.ErrorMessage)
			}
			return invalid("doesn't match the required format")
		}
	}

	// An inverted restriction is still a restriction. It is checked with the
	// same wording as its positive twin, because "must not match" is the whole
	// of what the schema said.
	for _, pattern := range val.NotPatterns {
		if pattern == "" {
			continue
		}
		re, err := compiled(pattern)
		if err != nil {
			return invalid("invalid validation pattern")
		}
		if re.MatchString(s) {
			return refuse(val, "this form of the value is not allowed here")
		}
	}

	if len(val.Enum) > 0 {
		found := false
		for _, e := range val.Enum {
			if e == s {
				found = true
				break
			}
		}
		if !found {
			return invalid("not one of the allowed values")
		}
	}

	// A flags value is any subset of the declared names, in any order, one per
	// word. Anything else names a flag the product has never heard of.
	if len(val.Bits) > 0 {
		allowed := make(map[string]bool, len(val.Bits))
		for _, b := range val.Bits {
			allowed[b] = true
		}
		for _, word := range strings.Fields(s) {
			if !allowed[word] {
				return invalid(fmt.Sprintf("%q is not one of the allowed flags (%s)",
					word, strings.Join(val.Bits, ", ")))
			}
		}
	}

	if r := checkNumericRules(val, s); !r.Valid {
		return r
	}

	n := len([]rune(s))
	if val.MinLength != nil && n < *val.MinLength {
		return refuse(val, fmt.Sprintf("shorter than %d characters", *val.MinLength))
	}
	if val.MaxLength != nil && n > *val.MaxLength {
		return refuse(val, fmt.Sprintf("longer than %d characters", *val.MaxLength))
	}
	// Disjoint length spans, for the same reason disjoint ranges exist: a
	// restriction reading "8 or 16 or 32" is not the span 8..32.
	if len(val.Lengths) > 1 && !inAnySpan(val.Lengths, float64(n)) {
		return refuse(val, "the length has to be "+describeSpans(val.Lengths)+" characters")
	}

	return ok()
}

// checkNumericRules applies min/max, the disjoint spans that outrank them, and
// the decimal-place limit. A value that is not a number at all passes: its type
// check has already had its say, and a string parameter carrying a range is a
// schema's business, not this function's.
func checkNumericRules(val model.Validation, s string) Result {
	if val.Min == nil && val.Max == nil && len(val.Ranges) == 0 && val.MaxDecimals == nil {
		return ok()
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return ok()
	}
	// The disjoint spans are the real rule when there is more than one; Min/Max
	// only describe their outer edges, and a value in the gap between two spans
	// passes those while the schema refuses it.
	if len(val.Ranges) > 1 {
		if !inAnySpan(val.Ranges, f) {
			return refuse(val, "has to be "+describeSpans(val.Ranges))
		}
	} else {
		if val.Min != nil && f < *val.Min {
			return refuse(val, fmt.Sprintf("below minimum %v", *val.Min))
		}
		if val.Max != nil && f > *val.Max {
			return refuse(val, fmt.Sprintf("above maximum %v", *val.Max))
		}
	}
	if val.MaxDecimals != nil && decimals(s) > *val.MaxDecimals {
		return refuse(val, fmt.Sprintf("has more than %d decimal place(s)", *val.MaxDecimals))
	}
	return ok()
}

func inAnySpan(spans []model.Span, f float64) bool {
	for _, sp := range spans {
		if sp.Contains(f) {
			return true
		}
	}
	return false
}

// describeSpans words a set of spans the way the schema meant them: exact
// values stay exact, open ends read as open.
func describeSpans(spans []model.Span) string {
	parts := make([]string, 0, len(spans))
	for _, sp := range spans {
		switch {
		case sp.Min != nil && sp.Max != nil && *sp.Min == *sp.Max:
			parts = append(parts, trimNum(*sp.Min))
		case sp.Min != nil && sp.Max != nil:
			parts = append(parts, trimNum(*sp.Min)+" to "+trimNum(*sp.Max))
		case sp.Min != nil:
			parts = append(parts, trimNum(*sp.Min)+" or more")
		case sp.Max != nil:
			parts = append(parts, trimNum(*sp.Max)+" or less")
		}
	}
	if len(parts) == 0 {
		return "within the allowed range"
	}
	if len(parts) == 1 {
		return parts[0]
	}
	return strings.Join(parts[:len(parts)-1], ", ") + " or " + parts[len(parts)-1]
}

func trimNum(f float64) string {
	if f == math.Trunc(f) && math.Abs(f) < 1e15 {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// decimals counts the digits after the decimal point in a plain decimal
// spelling. An exponent form is not counted: nothing in a configuration file
// writes 1e-9 and pretending to measure it would refuse valid values.
func decimals(s string) int {
	s = strings.TrimSpace(s)
	if strings.ContainsAny(s, "eE") {
		return 0
	}
	i := strings.IndexByte(s, '.')
	if i < 0 {
		return 0
	}
	return len(strings.TrimRight(s[i+1:], "0"))
}

// refuse states a rejection in the schema's own words when it supplied any,
// falling back to the product's wording. A vendor sentence naming the setting
// beats a generic one describing arithmetic.
func refuse(val model.Validation, generic string) Result {
	if val.ErrorMessage != "" {
		return invalid(val.ErrorMessage)
	}
	return invalid(generic)
}
