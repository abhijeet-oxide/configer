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

func ok() Result                 { return Result{Valid: true} }
func invalid(msg string) Result  { return Result{Valid: false, Message: msg} }

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
	case model.TypeInteger:
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
	case model.TypeCIDR:
		if _, _, err := net.ParseCIDR(fmt.Sprintf("%v", v)); err != nil {
			return invalid("must be a valid CIDR block")
		}
	}
	return ok()
}

// applyRules enforces the explicit rule fields against the value's string form.
func applyRules(val model.Validation, s string) Result {
	if val.Pattern != "" {
		re, err := compiled(val.Pattern)
		if err != nil {
			return invalid("invalid validation pattern")
		}
		if !re.MatchString(s) {
			return invalid("doesn't match the required format")
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

	if val.Min != nil || val.Max != nil {
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			if val.Min != nil && f < *val.Min {
				return invalid(fmt.Sprintf("below minimum %v", *val.Min))
			}
			if val.Max != nil && f > *val.Max {
				return invalid(fmt.Sprintf("above maximum %v", *val.Max))
			}
		}
	}

	n := len([]rune(s))
	if val.MinLength != nil && n < *val.MinLength {
		return invalid(fmt.Sprintf("shorter than %d characters", *val.MinLength))
	}
	if val.MaxLength != nil && n > *val.MaxLength {
		return invalid(fmt.Sprintf("longer than %d characters", *val.MaxLength))
	}

	return ok()
}
