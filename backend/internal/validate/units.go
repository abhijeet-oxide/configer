package validate

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// Unit enforcement for the quantity types, in the one place a plain format
// check cannot reach: the moment a value CHANGES.
//
// Kubernetes writes CPU two legitimate ways - millicores ("350m") and bare
// cores ("2") - so a format rule cannot refuse a bare number without calling
// every `cpu: "1"` in a real chart invalid. But the two forms are a thousand
// times apart, and the whole hazard is a unit going missing: "350m" edited to
// "350" is not a small correction, it is 350 CPUs, and nothing in a before/after
// column makes that visible. So the rule is about the EDIT rather than the
// value: a quantity that was written with a unit has to keep one. Every
// intention still has a spelling ("2 cores" is "2000m"), so the check never
// blocks a change - it only refuses to guess which of two readings was meant.
//
// Memory has no such ambiguity: a bare number is bytes, which nobody writes on
// purpose, so quantity.go rejects it outright and this file adds nothing.

var bareNumberRe = regexp.MustCompile(`^\d+(\.\d+)?$`)

// unitOf returns the unit suffix a quantity value carries, and whether the
// value is a well-formed quantity of that type at all. A bare number is a
// valid CPU quantity with an empty unit.
func unitOf(t model.ParamType, v any) (unit string, isQuantity bool) {
	s := strings.TrimSpace(fmt.Sprintf("%v", v))
	if s == "" {
		return "", false
	}
	switch t {
	case model.TypeCPU:
		if !cpuRe.MatchString(s) {
			return "", false
		}
		if strings.HasSuffix(s, "m") {
			return "m", true
		}
		return "", true
	case model.TypeMemory:
		if u := memoryUnit(s); u != "" {
			return u, true
		}
		return "", bareNumberRe.MatchString(s)
	}
	return "", false
}

// UnitChange reports whether an edit drops the unit off a quantity that had
// one. It is the second half of quantity validation, applied by the write paths
// once the committed value is known, in the same shape as RelationCheck.
//
// Only the losing direction is refused. Adding a unit to a bare value, or
// swapping one unit for another, is a legible change a reviewer can read; a
// unit that simply vanishes is not, because the result still looks like a
// plausible number.
func UnitChange(param model.Parameter, oldV, newV any) Result {
	if param.Type != model.TypeCPU && param.Type != model.TypeMemory {
		return ok()
	}
	oldUnit, oldOK := unitOf(param.Type, oldV)
	newUnit, newOK := unitOf(param.Type, newV)
	if !oldOK || !newOK || oldUnit == "" || newUnit != "" {
		return ok()
	}
	newS := strings.TrimSpace(fmt.Sprintf("%v", newV))
	if param.Type == model.TypeCPU {
		return invalid(fmt.Sprintf(
			"this value is written in millicores (%v); %s has no unit, which means %s whole CPUs. Write %sm to keep the millicores, or the cores you mean as millicores (2 cores is 2000m)",
			oldV, newS, newS, newS))
	}
	return invalid(fmt.Sprintf(
		"this value is written with a unit (%v); %s has none, which means %s bytes. Add the unit you mean, for example %s%s",
		oldV, newS, newS, newS, oldUnit))
}
