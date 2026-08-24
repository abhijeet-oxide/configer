package yangschema

import (
	"reflect"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

func load(t *testing.T) *Set {
	t.Helper()
	set := Load("testdata", []string{"."})
	if set.Empty() {
		t.Fatal("no models loaded from testdata")
	}
	return set
}

// apply looks a value path up and applies what the model says to a parameter.
func apply(t *testing.T, set *Set, steps ...string) model.Parameter {
	t.Helper()
	n, found := set.Lookup(steps)
	if !found {
		t.Fatalf("no model node for %v", steps)
	}
	var p model.Parameter
	Apply(&p, n)
	return p
}

func TestTypedefChainKeepsEveryRestriction(t *testing.T) {
	p := apply(t, load(t), "radio", "cell", "name")

	if p.Type != model.TypeString {
		t.Errorf("type = %q, want string", p.Type)
	}
	// The nearer length wins; the pattern from further down the chain survives.
	if p.Validation.MinLength == nil || *p.Validation.MinLength != 2 {
		t.Errorf("minLength = %v, want 2", p.Validation.MinLength)
	}
	if p.Validation.MaxLength == nil || *p.Validation.MaxLength != 8 {
		t.Errorf("maxLength = %v, want 8", p.Validation.MaxLength)
	}
	if want := `^(?:[a-zA-Z][a-zA-Z0-9_-]*)$`; p.Validation.Pattern != want {
		t.Errorf("pattern = %q, want %q", p.Validation.Pattern, want)
	}
	// A list key must be set whether or not the model says "mandatory".
	if !p.Validation.Required {
		t.Error("a list key should be required")
	}
	if p.DisplayName != "Cell name" {
		t.Errorf("displayName = %q, want the extension's label", p.DisplayName)
	}
	if want := "Short name of the cell, unique within the site."; p.Description != want {
		t.Errorf("description = %q, want %q", p.Description, want)
	}
}

func TestRangeUnitsDefaultAndErrorWording(t *testing.T) {
	p := apply(t, load(t), "radio", "cell", "power")

	if p.Type != model.TypeInteger {
		t.Errorf("type = %q, want integer", p.Type)
	}
	if p.Validation.Min == nil || *p.Validation.Min != -30 {
		t.Errorf("min = %v, want -30", p.Validation.Min)
	}
	if p.Validation.Max == nil || *p.Validation.Max != 46 {
		t.Errorf("max = %v, want 46", p.Validation.Max)
	}
	if p.Validation.Units != "dBm" {
		t.Errorf("units = %q, want dBm", p.Validation.Units)
	}
	if want := "Transmit power must sit between -30 and 46 dBm."; p.Validation.ErrorMessage != want {
		t.Errorf("errorMessage = %q, want the model's own wording", p.Validation.ErrorMessage)
	}
	// The default is rendered in the parameter's type, not left as prose.
	if p.Default != int64(20) {
		t.Errorf("default = %#v, want int64(20)", p.Default)
	}
}

func TestEnumerationBooleanAndImplicitIntegerWidth(t *testing.T) {
	set := load(t)

	mode := apply(t, set, "radio", "cell", "mode")
	if mode.Type != model.TypeEnum {
		t.Errorf("mode type = %q, want enum", mode.Type)
	}
	if want := []string{"tdd", "fdd"}; !reflect.DeepEqual(mode.Validation.Enum, want) {
		t.Errorf("mode enum = %v, want %v", mode.Validation.Enum, want)
	}

	enabled := apply(t, set, "radio", "cell", "enabled")
	if enabled.Type != model.TypeBoolean || enabled.Default != true {
		t.Errorf("enabled = %q / %#v, want boolean / true", enabled.Type, enabled.Default)
	}

	// A width IS a range: "uint8" says 0..255 without stating it.
	slot := apply(t, set, "radio", "cell", "slot")
	if slot.Validation.Min == nil || *slot.Validation.Min != 0 {
		t.Errorf("slot min = %v, want 0", slot.Validation.Min)
	}
	if slot.Validation.Max == nil || *slot.Validation.Max != 255 {
		t.Errorf("slot max = %v, want 255", slot.Validation.Max)
	}
}

func TestConditionsThatCannotBeCheckedAreStatedInWords(t *testing.T) {
	set := load(t)

	// Disjoint ranges validate on the outer span and say what the spans are.
	bw := apply(t, set, "radio", "cell", "bandwidth")
	if bw.Validation.Min == nil || *bw.Validation.Min != 5 || bw.Validation.Max == nil || *bw.Validation.Max != 100 {
		t.Errorf("bandwidth span = %v..%v, want 5..100", bw.Validation.Min, bw.Validation.Max)
	}
	if want := []string{"allowed ranges: 5..20, 40..100"}; !reflect.DeepEqual(bw.Validation.Constraints, want) {
		t.Errorf("bandwidth constraints = %v, want %v", bw.Validation.Constraints, want)
	}

	// A union member's restrictions cannot be enforced alone, so none of them
	// becomes a rule and the alternatives are named instead.
	tag := apply(t, set, "radio", "cell", "tag")
	if tag.Validation.Pattern != "" || tag.Validation.Min != nil {
		t.Errorf("a union must produce no enforceable rule, got %+v", tag.Validation)
	}
	if want := []string{"one of: uint32, string"}; !reflect.DeepEqual(tag.Validation.Constraints, want) {
		t.Errorf("tag constraints = %v, want %v", tag.Validation.Constraints, want)
	}
}

func TestRepeatedNodeSizeFollowsTheParameter(t *testing.T) {
	set := load(t)
	n, found := set.Lookup([]string{"radio", "cell", "neighbour"})
	if !found {
		t.Fatal("no model node for neighbour")
	}

	// Addressed as one entry, the parameter stays a scalar and the size limits
	// are stated rather than turned into rules about the wrong thing.
	scalar := model.Parameter{Type: model.TypeString}
	Apply(&scalar, n)
	if scalar.Type != model.TypeString {
		t.Errorf("type = %q, want the entry's own type", scalar.Type)
	}
	if want := []string{"the list holds 1 to 16 entries"}; !reflect.DeepEqual(scalar.Validation.Constraints, want) {
		t.Errorf("constraints = %v, want %v", scalar.Validation.Constraints, want)
	}

	// Addressed as the whole collection, they become the rules they are.
	whole := model.Parameter{Type: model.TypeList}
	Apply(&whole, n)
	if whole.Type != model.TypeList || whole.ItemType != model.TypeString {
		t.Errorf("type/itemType = %q/%q, want list/string", whole.Type, whole.ItemType)
	}
	if whole.Validation.MinItems == nil || *whole.Validation.MinItems != 1 {
		t.Errorf("minItems = %v, want 1", whole.Validation.MinItems)
	}
	if whole.Validation.MaxItems == nil || *whole.Validation.MaxItems != 16 {
		t.Errorf("maxItems = %v, want 16", whole.Validation.MaxItems)
	}
}

func TestGroupingIsInlinedAndRefined(t *testing.T) {
	set := load(t)

	addr := apply(t, set, "radio", "cell", "address")
	if addr.Type != model.TypeIPv4 {
		t.Errorf("type = %q, want ipv4 - the type's NAME carries what the builtin lost", addr.Type)
	}
	if !addr.Validation.Required || addr.DisplayName != "Management address" {
		t.Errorf("grouping node lost its own statements: %+v", addr)
	}

	// The call site tightened the grouping; the refinement has to survive.
	port := apply(t, set, "radio", "cell", "listen-port")
	if port.Type != model.TypePort {
		t.Errorf("type = %q, want port", port.Type)
	}
	if !port.Validation.Required {
		t.Error("refine mandatory true was dropped")
	}
	if port.Default != int64(8080) {
		t.Errorf("default = %#v, want int64(8080)", port.Default)
	}
}

func TestDependencyExpressionsResolveToModelNodes(t *testing.T) {
	set := load(t)

	enabledMode, found := set.Lookup([]string{"radio", "cell", "enabled-mode"})
	if !found {
		t.Fatal("no model node for enabled-mode")
	}
	if want := []string{"../enabled"}; !reflect.DeepEqual(enabledMode.DependencyPaths, want) {
		t.Fatalf("enabled-mode dependencies = %v, want %v", enabledMode.DependencyPaths, want)
	}
	target, found := set.LookupDependency(enabledMode, "../enabled")
	if !found || target.Name != "enabled" {
		t.Fatalf("relative dependency resolved to %v, %v; want enabled", target, found)
	}

	primary, found := set.Lookup([]string{"radio", "cell", "primary-cell"})
	if !found {
		t.Fatal("no model node for primary-cell")
	}
	if want := []string{"/radio/cell/name"}; !reflect.DeepEqual(primary.DependencyPaths, want) {
		t.Fatalf("primary-cell dependencies = %v, want %v", primary.DependencyPaths, want)
	}
	target, found = set.LookupDependency(primary, "/radio/cell/name")
	if !found || target.Name != "name" {
		t.Fatalf("absolute dependency resolved to %v, %v; want name", target, found)
	}
}

func TestNodesAddedFromAnotherFileAreFound(t *testing.T) {
	// A model split across a module and its includes attaches most of its tree
	// with "augment", from a file that declares nothing in place. Reading only
	// what each file declares directly would leave those settings with no type,
	// no allowed values and no prose - which is the whole point of reading the
	// models at all.
	p := apply(t, load(t), "radio", "cell", "sending-state")

	if p.Type != model.TypeEnum {
		t.Errorf("type = %q, want enum", p.Type)
	}
	if want := []string{"enable", "disable"}; !reflect.DeepEqual(p.Validation.Enum, want) {
		t.Errorf("enum = %v, want %v", p.Validation.Enum, want)
	}
	if want := "Enables or disables the sending of information alarms."; p.Description != want {
		t.Errorf("description = %q, want %q", p.Description, want)
	}
	if p.DisplayName != "Alarm Send State" {
		t.Errorf("displayName = %q", p.DisplayName)
	}
	if p.Default != "enable" {
		t.Errorf("default = %#v, want %q", p.Default, "enable")
	}
	// It answers to the route the AUGMENT names, which is the route the real
	// tree addresses it by - not one built from the file it happens to sit in.
	n, found := load(t).Lookup([]string{"radio", "cell", "sending-state"})
	if !found || n.File != "acme-radio-extras.yang" {
		t.Errorf("lookup = %v, %v; want the node from the augmenting file", n, found)
	}
}

func TestLookupPrefersTheLongerRouteAndRefusesAmbiguity(t *testing.T) {
	set := load(t)

	// Two modules both end in cell/name with DIFFERENT rules: answering would
	// mean attributing one vendor's constraint to another's setting.
	if n, found := set.Lookup([]string{"cell", "name"}); found {
		t.Errorf("ambiguous route answered with %s/%s", n.Module, n.Name)
	}
	// One more step of agreement settles it.
	if n, found := set.Lookup([]string{"radio", "cell", "name"}); !found || n.Module != "acme-radio" {
		t.Errorf("longer route did not win: %v %v", n, found)
	}
	if n, found := set.Lookup([]string{"backup", "cell", "name"}); !found || n.Module != "acme-other" {
		t.Errorf("longer route did not win: %v %v", n, found)
	}
	// A leaf nothing models is simply not known.
	if _, found := set.Lookup([]string{"radio", "cell", "nonesuch"}); found {
		t.Error("answered for a leaf no model defines")
	}
}

func TestDocumentSpellingIsIgnoredWhenMatching(t *testing.T) {
	set := load(t)
	// Prefixes, positional predicates and attribute markers describe the
	// DOCUMENT; a model has never seen any of them.
	n, found := set.Lookup([]string{"acme:radio", "acme:cell[2]", "@power"})
	if !found || n.Name != "power" {
		t.Fatalf("lookup = %v, %v; want the power leaf", n, found)
	}
}

func TestAPersonsOwnWordsAreNotOverwritten(t *testing.T) {
	set := load(t)
	n, _ := set.Lookup([]string{"radio", "cell", "power"})
	p := model.Parameter{Description: "ours", DisplayName: "Ours"}
	Apply(&p, n)
	if p.Description != "ours" || p.DisplayName != "Ours" {
		t.Errorf("a schema overwrote what somebody chose: %+v", p)
	}
}

func TestADeclaredDefaultBeatsAnInferredOne(t *testing.T) {
	set := load(t)
	n, _ := set.Lookup([]string{"radio", "cell", "power"})
	// Discovery's guess is "every instance currently holds 41", which says
	// nothing about what a NEW instance should start at.
	p := model.Parameter{Default: 41}
	Apply(&p, n)
	if p.Default != int64(20) {
		t.Errorf("default = %#v, want the model's own 20", p.Default)
	}
}

func TestUnparseableModelIsPassedOverNotFatal(t *testing.T) {
	if _, err := Parse([]byte("module broken { container c {")); err == nil {
		t.Error("an unterminated block should not parse")
	}
	// Comments, concatenation and escapes all read the way the language says.
	st, err := Parse([]byte(`module m { // trailing
		/* block */
		leaf a { type string { pattern "^[\\S]+" + "$"; } }
	}`))
	if err != nil {
		t.Fatal(err)
	}
	got := st.Child("leaf").Child("type").ChildArg("pattern")
	if got != `^[\S]+$` {
		t.Errorf("pattern = %q, want %q", got, `^[\S]+$`)
	}
}
