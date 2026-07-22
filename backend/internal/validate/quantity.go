package validate

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// Well-known operational quantity types - CPU, memory/bytes, duration,
// percentage - parsed the way Kubernetes and Helm charts write them, so the
// tool can validate the values people actually type ("500m", "1Gi", "30s",
// "75%") instead of treating them as opaque strings. Every quantity is required
// to be positive: a CPU or memory request of zero or a negative amount is never
// valid.

var (
	// CPU: cores ("1", "2.5") or millicores ("500m"). A bare number is cores.
	cpuRe = regexp.MustCompile(`^\d+(\.\d+)?m?$`)
	// Memory / byte quantity: a number with an optional binary (Ki..Ei) or
	// decimal (k/K..E, and milli "m") SI suffix, per resource.Quantity.
	memoryRe = regexp.MustCompile(`^\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|Ei|[kKMGTPE]|m)?$`)
	// A memory quantity that carries a unit suffix - used for DETECTION so a
	// plain integer count is not mistaken for a byte size.
	memoryUnitRe = regexp.MustCompile(`^\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|Ei|[kKMGTPE])$`)
	durationRe   = regexp.MustCompile(`^\d+(\.\d+)?(ns|us|ms|s|m|h|d)$`)
	percentRe    = regexp.MustCompile(`^\d+(\.\d+)?%$`)
)

// binary/decimal SI multipliers for byte quantities.
var siMultiplier = map[string]float64{
	"": 1,
	"m": 0.001,
	"k": 1e3, "K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12, "P": 1e15, "E": 1e18,
	"Ki": 1 << 10, "Mi": 1 << 20, "Gi": 1 << 30, "Ti": 1 << 40, "Pi": 1 << 50, "Ei": 1 << 60,
}

// parseCPU returns CPU in millicores. "1" -> 1000, "500m" -> 500, "2.5" -> 2500.
func parseCPU(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if !cpuRe.MatchString(s) {
		return 0, false
	}
	if strings.HasSuffix(s, "m") {
		n, err := strconv.ParseFloat(strings.TrimSuffix(s, "m"), 64)
		if err != nil {
			return 0, false
		}
		return n, true
	}
	cores, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return cores * 1000, true
}

// parseMemory returns a byte quantity as a float. Accepts binary and decimal SI
// suffixes; a bare number is bytes.
func parseMemory(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if !memoryRe.MatchString(s) {
		return 0, false
	}
	suffix := ""
	for _, suf := range []string{"Ki", "Mi", "Gi", "Ti", "Pi", "Ei"} {
		if strings.HasSuffix(s, suf) {
			suffix = suf
			break
		}
	}
	if suffix == "" {
		last := s[len(s)-1:]
		if _, ok := siMultiplier[last]; ok && (last < "0" || last > "9") {
			suffix = last
		}
	}
	num := strings.TrimSuffix(s, suffix)
	n, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return 0, false
	}
	return n * siMultiplier[suffix], true
}

// parseDuration returns a duration in seconds.
func parseDuration(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	m := durationRe.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	unit := m[2]
	num := strings.TrimSuffix(s, unit)
	n, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return 0, false
	}
	scale := map[string]float64{"ns": 1e-9, "us": 1e-6, "ms": 1e-3, "s": 1, "m": 60, "h": 3600, "d": 86400}
	return n * scale[unit], true
}

// parsePercent returns the numeric part of "75%".
func parsePercent(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if !percentRe.MatchString(s) {
		return 0, false
	}
	n, err := strconv.ParseFloat(strings.TrimSuffix(s, "%"), 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

// quantityValue converts a value to a comparable magnitude for a quantity type.
// The bool reports whether the type is a quantity and the value parsed.
func quantityValue(t model.ParamType, v any) (float64, bool) {
	s := fmt.Sprintf("%v", v)
	switch t {
	case model.TypeCPU:
		return parseCPU(s)
	case model.TypeMemory:
		return parseMemory(s)
	case model.TypeDuration:
		return parseDuration(s)
	case model.TypePercentage:
		return parsePercent(s)
	case model.TypeInteger, model.TypeNumber, model.TypePort:
		f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
		return f, err == nil
	}
	return 0, false
}

// checkQuantityType validates a value against one of the quantity types,
// enforcing both the format and positivity. Returns (result, handled) where
// handled is false when t is not a quantity type.
func checkQuantityType(t model.ParamType, v any) (Result, bool) {
	s := fmt.Sprintf("%v", v)
	switch t {
	case model.TypeCPU:
		n, ok := parseCPU(s)
		if !ok {
			return invalid("must be a CPU quantity in cores or millicores, for example 500m or 2"), true
		}
		if n <= 0 {
			return invalid("CPU must be greater than zero"), true
		}
	case model.TypeMemory:
		n, ok := parseMemory(s)
		if !ok {
			return invalid("must be a memory quantity, for example 256Mi or 1Gi"), true
		}
		if n <= 0 {
			return invalid("memory must be greater than zero"), true
		}
	case model.TypeDuration:
		n, ok := parseDuration(s)
		if !ok {
			return invalid("must be a duration with a unit, for example 30s or 5m"), true
		}
		if n < 0 {
			return invalid("duration cannot be negative"), true
		}
	case model.TypePercentage:
		n, ok := parsePercent(s)
		if !ok {
			return invalid("must be a percentage, for example 75%"), true
		}
		if n < 0 || n > 100 {
			return invalid("percentage must be between 0% and 100%"), true
		}
	default:
		return ok(), false
	}
	return ok(), true
}

// ValueInContext validates v against param, then applies any cross-parameter
// relation (AtLeast / AtMost) using related to fetch a sibling parameter and
// its effective value at the same instance. related returns (parameter, value,
// ok). When the sibling cannot be resolved the relation is skipped rather than
// failing, so a half-configured pair never blocks an edit.
func ValueInContext(param model.Parameter, v any, related func(id string) (model.Parameter, any, bool)) Result {
	if r := Value(param, v); !r.Valid {
		return r
	}
	return RelationCheck(param, v, related)
}

// RelationCheck applies ONLY the cross-parameter AtLeast/AtMost constraints,
// assuming the value has already passed Value(). Callers that validate earlier
// in the request (before the instance context is known) use this to add the
// relational check once the sibling can be resolved.
func RelationCheck(param model.Parameter, v any, related func(id string) (model.Parameter, any, bool)) Result {
	if v == nil || v == "" {
		return ok()
	}
	val := param.Validation
	if val.AtLeast != "" {
		if other, ov, okr := related(val.AtLeast); okr {
			if r := compareRelation(param, v, other, ov, true); !r.Valid {
				return r
			}
		}
	}
	if val.AtMost != "" {
		if other, ov, okr := related(val.AtMost); okr {
			if r := compareRelation(param, v, other, ov, false); !r.Valid {
				return r
			}
		}
	}
	return ok()
}

// compareRelation checks v against the other parameter's value ov. When atLeast
// is true, v must be >= ov; otherwise v must be <= ov. The magnitude uses this
// parameter's quantity type so CPU/memory compare by real amount.
func compareRelation(param model.Parameter, v any, other model.Parameter, ov any, atLeast bool) Result {
	if ov == nil || ov == "" {
		return ok()
	}
	a, aok := quantityValue(param.Type, v)
	b, bok := quantityValue(param.Type, ov)
	if !aok || !bok {
		return ok() // not comparable as quantities; skip rather than false-fail
	}
	label := other.DisplayName
	if label == "" {
		label = other.Name
	}
	if atLeast && a < b {
		return invalid(fmt.Sprintf("must be at least %s (%v)", label, ov))
	}
	if !atLeast && a > b {
		return invalid(fmt.Sprintf("must not exceed %s (%v)", label, ov))
	}
	return ok()
}
