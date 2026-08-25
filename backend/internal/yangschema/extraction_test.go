package yangschema

// These tests cover the facts a model states that a single-value rule can
// still enforce: extensible enumerations, flags, disjoint ranges, decimal
// precision, alternatives, inverted patterns, and the vendor's own
// disagreements with its own model. Each of them used to arrive as a sentence
// beside the editor and nothing else, which meant the value went to the device
// unchecked.

import (
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/validate"
)

// check runs a value through the full write-path validation for a parameter,
// which is what actually decides whether an edit is allowed.
func check(t *testing.T, p model.Parameter, v any) validate.Result {
	t.Helper()
	coerced, err := validate.CoerceValue(p, v)
	if err != nil {
		return validate.Result{Valid: false, Message: err.Error()}
	}
	return validate.Value(p, coerced)
}

func TestIdentityrefBecomesItsDerivedValues(t *testing.T) {
	p := apply(t, load(t), "transport-config", "link")

	if p.Type != model.TypeEnum {
		t.Fatalf("type = %q, want enum: an identityref's values are knowable", p.Type)
	}
	want := map[string]bool{"copper": true, "fibre": true}
	if len(p.Validation.Enum) != len(want) {
		t.Fatalf("enum = %v, want the identities deriving from transport", p.Validation.Enum)
	}
	for _, e := range p.Validation.Enum {
		if !want[e] {
			t.Errorf("enum has %q, which does not derive from transport", e)
		}
	}
	if r := check(t, p, "satellite"); r.Valid {
		t.Error("an identity nobody declared was accepted")
	}
}

func TestTypedefCarriesDefaultAndUnits(t *testing.T) {
	// The deviation narrows the range and makes it mandatory; the typedef still
	// supplies the unit and the prose.
	p := apply(t, load(t), "transport-config", "hold-timer")

	if p.Validation.Units != "seconds" {
		t.Errorf("units = %q, want the typedef's own unit", p.Validation.Units)
	}
	if p.Default != int64(30) {
		t.Errorf("default = %#v, want the typedef's default 30", p.Default)
	}
	if p.Description == "" {
		t.Error("the typedef's description did not reach the parameter")
	}
}

func TestDeviationReplacesTheModelsOwnRule(t *testing.T) {
	p := apply(t, load(t), "transport-config", "hold-timer")

	if p.Validation.Max == nil || *p.Validation.Max != 600 {
		t.Errorf("max = %v, want 600 from the deviation, not 3600 from the typedef", p.Validation.Max)
	}
	if p.Validation.Min == nil || *p.Validation.Min != 5 {
		t.Errorf("min = %v, want 5 from the deviation", p.Validation.Min)
	}
	if !p.Validation.Required {
		t.Error("the deviation added mandatory true and it was not applied")
	}
	if r := check(t, p, 1000); r.Valid {
		t.Error("a value the device refuses was accepted by the undeviated range")
	}
}

func TestNotSupportedDeviationRemovesTheNode(t *testing.T) {
	set := load(t)
	if _, found := set.Lookup([]string{"transport-config", "legacy-mode"}); found {
		t.Error("a node the vendor deviated as not-supported is still offered")
	}
}

func TestDecimalPrecisionIsARule(t *testing.T) {
	p := apply(t, load(t), "transport-config", "ratio")

	if p.Validation.MaxDecimals == nil || *p.Validation.MaxDecimals != 2 {
		t.Fatalf("maxDecimals = %v, want 2", p.Validation.MaxDecimals)
	}
	if r := check(t, p, "0.25"); !r.Valid {
		t.Errorf("0.25 rejected: %s", r.Message)
	}
	if r := check(t, p, "0.255"); r.Valid {
		t.Error("a value with more decimal places than the type can hold was accepted")
	}
}

func TestBitsAreCheckedNotJustListed(t *testing.T) {
	p := apply(t, load(t), "transport-config", "flags")

	if len(p.Validation.Bits) != 2 {
		t.Fatalf("bits = %v, want both declared flags", p.Validation.Bits)
	}
	if r := check(t, p, "low-latency redundant"); !r.Valid {
		t.Errorf("a combination of declared flags was rejected: %s", r.Message)
	}
	if r := check(t, p, "low-latency redundent"); r.Valid {
		t.Error("a misspelled flag reached the device")
	}
}

func TestDisjointRangesRefuseTheGap(t *testing.T) {
	p := apply(t, load(t), "radio", "cell", "bandwidth")

	if len(p.Validation.Ranges) != 2 {
		t.Fatalf("ranges = %v, want both spans of 5..20 | 40..100", p.Validation.Ranges)
	}
	for _, ok := range []any{5, 20, 40, 100} {
		if r := check(t, p, ok); !r.Valid {
			t.Errorf("%v rejected: %s", ok, r.Message)
		}
	}
	if r := check(t, p, 30); r.Valid {
		t.Error("30 sits in the gap between the two allowed spans and was accepted")
	}
}

func TestUnionAcceptsEitherSpellingAndRefusesNeither(t *testing.T) {
	p := apply(t, load(t), "radio", "cell", "tag")

	if len(p.Validation.AnyOf) != 2 {
		t.Fatalf("anyOf = %v, want one alternative per union member", p.Validation.AnyOf)
	}
	if r := check(t, p, "4000"); !r.Valid {
		t.Errorf("the numeric member was rejected: %s", r.Message)
	}
	if r := check(t, p, "auto"); !r.Valid {
		t.Errorf("the string member was rejected: %s", r.Message)
	}
	if r := check(t, p, "atuo"); r.Valid {
		t.Error("a value no union member accepts was accepted")
	}
}

func TestInvertedPatternIsEnforced(t *testing.T) {
	p := apply(t, load(t), "transport-config", "reserved-name")

	if len(p.Validation.NotPatterns) != 1 {
		t.Fatalf("notPatterns = %v, want the inverted pattern", p.Validation.NotPatterns)
	}
	if r := check(t, p, "prod-1"); !r.Valid {
		t.Errorf("a permitted name was rejected: %s", r.Message)
	}
	if r := check(t, p, "tmp-scratch"); r.Valid {
		t.Error("a name the schema inverted a pattern to refuse was accepted")
	}
}

// An XSD class subtraction compiles in Go as a DIFFERENT rule - one that
// admits exactly the characters the vendor wrote it to exclude.
func TestClassSubtractionIsTranslatedNotMisread(t *testing.T) {
	p := apply(t, load(t), "transport-config", "code")

	if p.Validation.Pattern == "" {
		t.Fatal("the pattern was dropped to prose instead of being translated")
	}
	if r := check(t, p, "xyz"); !r.Valid {
		t.Errorf("consonants rejected: %s", r.Message)
	}
	if r := check(t, p, "bad"); r.Valid {
		t.Error("a vowel got through a pattern written to subtract the vowels")
	}
}

func TestOperationalStateIsReadOnly(t *testing.T) {
	p := apply(t, load(t), "radio", "cell", "counters")

	if !p.Validation.ReadOnly {
		t.Error("a config-false node is not marked read-only, so the UI would offer to write it")
	}
}

func TestChoiceAndPresenceAreRecorded(t *testing.T) {
	set := load(t)
	n, found := set.Lookup([]string{"transport-config", "wired-mtu"})
	if !found {
		t.Fatal("a node under a choice case was not indexed")
	}
	if n.Choice != "backhaul" || n.Case != "wired" {
		t.Errorf("choice/case = %q/%q, want backhaul/wired", n.Choice, n.Case)
	}
	if !n.ChoiceMandatory {
		t.Error("the choice was declared mandatory and that was lost")
	}
	container := set.byRoute([]string{"transport-config"})
	if container == nil || !container.Presence {
		t.Error("a presence container was not recorded as one")
	}
}

func TestFeatureGateIsRecorded(t *testing.T) {
	set := load(t)
	n, found := set.Lookup([]string{"transport-config", "aggregated-carriers"})
	if !found {
		t.Fatal("a feature-gated node was dropped rather than marked")
	}
	if len(n.IfFeatures) != 1 || n.IfFeatures[0] != "carrier-aggregation" {
		t.Errorf("ifFeatures = %v, want the gate the model declared", n.IfFeatures)
	}
	if n.FeatureOff {
		t.Error("with no declared feature set every feature counts as enabled")
	}

	// A deployment that DOES declare its features gets the gate honoured.
	narrowed := LoadWith("testdata", []string{"."}, LoadOptions{Features: []string{"something-else"}})
	off, found := narrowed.Lookup([]string{"transport-config", "aggregated-carriers"})
	if !found {
		t.Fatal("a feature-gated node was removed instead of marked")
	}
	if !off.FeatureOff {
		t.Error("a node needing an unsupported feature was not marked as such")
	}
}
