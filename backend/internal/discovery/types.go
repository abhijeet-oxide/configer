package discovery

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// Well-known type detection: after the structural discovery, look at each
// parameter's leaf name and the values it actually holds and, where it can be
// done RELIABLY, promote it from a bland string/number to a specific
// operational type (Kubernetes CPU/memory quantity, duration, percentage) or
// attach a matching preset (semantic version). A specific type carries its own
// validation - a CPU or memory amount must parse and be positive - so onboarding
// proposes real rules instead of leaving every quantity an unchecked string.

var (
	cpuValueRe     = regexp.MustCompile(`^\d+(\.\d+)?m?$`)
	memUnitValueRe = regexp.MustCompile(`^\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|Ei|[kKMGTPE])$`)
	durValueRe     = regexp.MustCompile(`^\d+(\.\d+)?(ns|us|ms|s|m|h|d)$`)
	pctValueRe     = regexp.MustCompile(`^\d+(\.\d+)?%$`)
	semverValueRe  = regexp.MustCompile(`^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`)
)

// durationLeaf reports whether a leaf name suggests a time span, so a value
// like "5m" is read as five minutes rather than a CPU or byte quantity.
var durationLeafRe = regexp.MustCompile(`(?i)(timeout|interval|ttl|duration|expiry|expiration|period|delay|backoff|leasetime|keepalive|deadline|grace)`)

// refineType promotes p to a specific well-known type when its leaf name and
// sampled values agree. It never overrides an enum or a type a schema already
// pinned to something structured; it only sharpens strings and numbers.
func refineType(p *model.Parameter) {
	if len(p.Validation.Enum) > 0 || p.Type == model.TypeEnum || p.Type == model.TypeBoolean || p.Type == model.TypeList {
		return
	}
	leaf := strings.ToLower(leafOf(p.Name))
	sample, ok := sampleValue(p)
	if !ok {
		return
	}
	s := strings.TrimSpace(fmt.Sprintf("%v", sample))
	if s == "" {
		return
	}

	switch {
	case pctValueRe.MatchString(s):
		p.Type = model.TypePercentage
	case leaf == "cpu" && cpuValueRe.MatchString(s):
		p.Type = model.TypeCPU
	case isMemoryLeaf(leaf) && memUnitValueRe.MatchString(s):
		p.Type = model.TypeMemory
	case durationLeafRe.MatchString(leaf) && durValueRe.MatchString(s):
		p.Type = model.TypeDuration
	case (leaf == "tag" || leaf == "version" || strings.HasSuffix(leaf, "version")) &&
		p.Type == model.TypeString && p.Validation.Preset == "" && p.Validation.Pattern == "" &&
		semverValueRe.MatchString(s):
		p.Validation.Preset = "semver"
	}
}

func isMemoryLeaf(leaf string) bool {
	switch leaf {
	case "memory", "storage", "disk":
		return true
	}
	return strings.HasSuffix(leaf, "size") || strings.HasSuffix(leaf, "memory") || strings.HasSuffix(leaf, "storage")
}

// sampleValue returns a representative value for a parameter: any observed
// per-instance value, else its default.
func sampleValue(p *model.Parameter) (any, bool) {
	for _, v := range p.Observed {
		if v != nil && v != "" {
			return v, true
		}
	}
	if p.Default != nil && p.Default != "" {
		return p.Default, true
	}
	return nil, false
}

// linkResourceConstraints wires the classic Kubernetes pairing: a resource
// limit must never fall below its matching request. For every parameter bound
// to a "...limits.<res>" path whose sibling "...requests.<res>" is also managed
// (same file, both CPU or both memory), it records the relation on both sides
// so a write that would make a limit smaller than its request - or a request
// larger than its limit - is rejected.
func linkResourceConstraints(params []model.Parameter) {
	byLoc := map[string]int{}
	for i, p := range params {
		if len(p.Bindings) == 0 {
			continue
		}
		b := p.Bindings[0]
		byLoc[b.File+"|"+b.Path] = i
	}
	for i := range params {
		if len(params[i].Bindings) == 0 {
			continue
		}
		b := params[i].Bindings[0]
		if !strings.Contains(b.Path, "limits") {
			continue
		}
		reqPath := replaceOnce(b.Path, "limits", "requests")
		if reqPath == b.Path {
			continue
		}
		j, ok := byLoc[b.File+"|"+reqPath]
		if !ok {
			continue
		}
		if !isQuantityType(params[i].Type) || params[i].Type != params[j].Type {
			continue
		}
		// limit >= request; request <= limit.
		params[i].Validation.AtLeast = params[j].ID
		params[j].Validation.AtMost = params[i].ID
	}
}

func isQuantityType(t model.ParamType) bool {
	return t == model.TypeCPU || t == model.TypeMemory
}

// replaceOnce replaces the first whole occurrence of old surrounded by path
// separators (".old." or ".old" at the end) so "limits" in a key does not match
// inside an unrelated word.
func replaceOnce(path, old, next string) string {
	for _, pat := range []string{"." + old + ".", "." + old} {
		if strings.Contains(path, pat) {
			return strings.Replace(path, pat, strings.Replace(pat, old, next, 1), 1)
		}
	}
	return path
}
