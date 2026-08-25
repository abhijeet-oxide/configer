package yangvalidate

// These tests are about the questions a single value cannot answer. Every one
// of them describes a change that passes cell-level validation and would still
// break the device.

import (
	"context"
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/yangschema"
)

func models(t *testing.T) *yangschema.Set {
	t.Helper()
	set := yangschema.Load("../yangschema/testdata", []string{"."})
	if set.Empty() {
		t.Fatal("no models loaded")
	}
	return set
}

// validateYAML runs the native engine over one YAML document.
func validateYAML(t *testing.T, body string) Report {
	t.Helper()
	n := &Native{}
	rep, err := n.Validate(context.Background(), Request{
		Set:       models(t),
		Documents: []Document{{File: "config.yaml", Format: "yaml", Content: []byte(body)}},
	})
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	return rep
}

// findingFor returns the first finding of a rule, or fails with what WAS found -
// a test that just says "expected an error" makes the next person run it twice.
func findingFor(t *testing.T, rep Report, rule string) Finding {
	t.Helper()
	for _, f := range rep.Findings {
		if f.Rule == rule {
			return f
		}
	}
	var got []string
	for _, f := range rep.Findings {
		got = append(got, f.Rule+": "+f.Message)
	}
	t.Fatalf("no %s finding; got %v", rule, got)
	return Finding{}
}

func assertClean(t *testing.T, rep Report) {
	t.Helper()
	if errs := rep.Errors(); len(errs) > 0 {
		var got []string
		for _, f := range errs {
			got = append(got, f.Rule+" at "+f.Path+": "+f.Message)
		}
		t.Fatalf("expected a clean document, got %v", got)
	}
}

// A document that satisfies every rule must produce nothing. A validator that
// cries wolf on correct input is one people learn to click past.
const validRadio = `
radio:
  cell:
    - name: alpha
      power: 20
      mode: fdd
      enabled: true
      slot: 3
      bandwidth: 20
      tag: auto
      primary-cell: alpha
      neighbour: [beta]
      address: 10.0.0.1
      listen-port: 8080
`

func TestAValidDocumentProducesNothing(t *testing.T) {
	rep := validateYAML(t, validRadio)
	assertClean(t, rep)
	if rep.Values == 0 {
		t.Fatal("no values were checked, so the clean result means nothing")
	}
	if !rep.Available {
		t.Fatalf("engine reported unavailable: %s", rep.Reason)
	}
}

func TestMandatoryLeafLeftOut(t *testing.T) {
	// "address" is mandatory in the grouping; "listen-port" is refined to
	// mandatory at the call site. Neither is set here.
	rep := validateYAML(t, `
radio:
  cell:
    - name: alpha
      neighbour: [beta]
`)
	var missing []string
	for _, f := range rep.Findings {
		if f.Rule == RuleMandatory {
			missing = append(missing, f.Name)
		}
	}
	if len(missing) < 2 {
		t.Fatalf("missing mandatory leaves = %v, want both address and listen-port", missing)
	}
}

func TestListKeyMissingAndRepeated(t *testing.T) {
	rep := validateYAML(t, `
radio:
  cell:
    - name: alpha
      address: 10.0.0.1
      listen-port: 80
      neighbour: [beta]
    - name: alpha
      address: 10.0.0.2
      listen-port: 81
      neighbour: [beta]
`)
	f := findingFor(t, rep, RuleKey)
	if !strings.Contains(f.Message, "repeats the identity") {
		t.Errorf("message = %q, want it to name the collision", f.Message)
	}
}

func TestUniqueAcrossEntries(t *testing.T) {
	// The model declares unique "name" on cell, so two entries sharing one is a
	// violation even before the key check has its say.
	rep := validateYAML(t, `
radio:
  cell:
    - name: alpha
      address: 10.0.0.1
      listen-port: 80
      neighbour: [beta]
    - name: alpha
      address: 10.0.0.2
      listen-port: 81
      neighbour: [gamma]
`)
	findingFor(t, rep, RuleUnique)
}

func TestLeafrefPointingAtNothing(t *testing.T) {
	rep := validateYAML(t, `
radio:
  cell:
    - name: alpha
      address: 10.0.0.1
      listen-port: 80
      neighbour: [beta]
      primary-cell: omega
`)
	f := findingFor(t, rep, RuleLeafref)
	if !strings.Contains(f.Message, "omega") {
		t.Errorf("message = %q, want it to name the dangling value", f.Message)
	}
}

func TestMinAndMaxElements(t *testing.T) {
	rep := validateYAML(t, `
radio:
  cell:
    - name: alpha
      address: 10.0.0.1
      listen-port: 80
      neighbour: []
`)
	f := findingFor(t, rep, RuleCount)
	if !strings.Contains(f.Message, "at least 1") {
		t.Errorf("message = %q, want the model's own minimum", f.Message)
	}
}

// "must count(./neighbour) > 0" is an expression the subset reads, so it is a
// real gate rather than a sentence beside the editor.
func TestMustExpressionIsEvaluated(t *testing.T) {
	rep := validateYAML(t, `
radio:
  cell:
    - name: alpha
      address: 10.0.0.1
      listen-port: 80
`)
	f := findingFor(t, rep, RuleMust)
	if f.Message != "A cell needs at least one neighbour." {
		t.Errorf("message = %q, want the model's own wording", f.Message)
	}
}

// "when ../enabled = 'true'" is false here, so the leaf should not be present.
func TestWhenConditionThatDoesNotHold(t *testing.T) {
	rep := validateYAML(t, `
radio:
  cell:
    - name: alpha
      address: 10.0.0.1
      listen-port: 80
      neighbour: [beta]
      enabled: false
      enabled-mode: auto
`)
	f := findingFor(t, rep, RuleWhen)
	if f.Severity != SeverityWarning {
		t.Errorf("severity = %q; a when that depends on another file must not block a submit", f.Severity)
	}
}

func TestChoiceWithBothBranchesFilledIn(t *testing.T) {
	rep := validateYAML(t, `
transport-config:
  link: fibre
  hold-timer: 30
  wired-mtu: 1500
  wireless-band: n78
`)
	f := findingFor(t, rep, RuleChoice)
	if !strings.Contains(f.Message, "wired") || !strings.Contains(f.Message, "wireless") {
		t.Errorf("message = %q, want it to name both branches", f.Message)
	}
}

func TestMandatoryChoiceWithNoBranchChosen(t *testing.T) {
	rep := validateYAML(t, `
transport-config:
  link: fibre
  hold-timer: 30
`)
	f := findingFor(t, rep, RuleChoice)
	if !strings.Contains(f.Message, "has to be chosen") {
		t.Errorf("message = %q, want it to ask for a choice", f.Message)
	}
}

// A file edited by hand never went through the cell write path, so this is the
// first thing that holds its values against their own types.
func TestPerValueRulesApplyToAHandEditedFile(t *testing.T) {
	rep := validateYAML(t, `
radio:
  cell:
    - name: alpha
      address: not-an-address
      listen-port: 80
      neighbour: [beta]
      power: 500
`)
	var messages []string
	for _, f := range rep.Findings {
		if f.Rule == RuleType {
			messages = append(messages, f.Message)
		}
	}
	if len(messages) < 2 {
		t.Fatalf("type findings = %v, want the bad address AND the out-of-range power", messages)
	}
}

func TestJSONDocumentsValidateToo(t *testing.T) {
	n := &Native{}
	rep, err := n.Validate(context.Background(), Request{
		Set: models(t),
		Documents: []Document{{File: "config.json", Format: "json", Content: []byte(`{
  "acme-radio:radio": {
    "cell": [
      { "name": "alpha", "address": "10.0.0.1", "listen-port": 80, "neighbour": ["beta"], "primary-cell": "omega" }
    ]
  }
}`)}},
	})
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	// The RFC 7951 "module:node" spelling must not stop the model matching, and
	// the dangling reference must still be caught.
	findingFor(t, rep, RuleLeafref)
	if rep.Values == 0 {
		t.Fatal("no values checked in the JSON document")
	}
}

func TestXMLDocumentsValidateToo(t *testing.T) {
	n := &Native{}
	rep, err := n.Validate(context.Background(), Request{
		Set: models(t),
		Documents: []Document{{File: "config.xml", Format: "xml", Content: []byte(
			`<radio xmlns="urn:acme"><cell><name>alpha</name><address>nonsense</address>` +
				`<listen-port>80</listen-port><neighbour>beta</neighbour></cell></radio>`)}},
	})
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	findingFor(t, rep, RuleType)
}

// An unmodelled file is not a broken file. A repository holds Kubernetes
// envelopes, Helm values and readme fragments beside whatever the models
// describe, and refusing them would make the tier unusable.
func TestUnmodelledContentIsCountedNotRefused(t *testing.T) {
	rep := validateYAML(t, `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
`)
	assertClean(t, rep)
	if rep.Unmatched == 0 {
		t.Error("unmodelled leaves were not counted, so the report cannot say the file is unmodelled")
	}
}

// A file that does not parse is the editor's problem and already has its own
// error. Reporting it here would name the wrong culprit.
func TestBrokenFileIsSkippedNotBlamedOnTheModel(t *testing.T) {
	rep := validateYAML(t, "radio:\n  cell:\n   - name: [unterminated\n")
	if len(rep.Skipped) == 0 {
		t.Error("an unparseable file was not reported as skipped")
	}
	for _, f := range rep.Findings {
		if f.Severity == SeverityError {
			t.Errorf("a syntax problem produced a model finding: %s", f.Message)
		}
	}
}

func TestNoModelsIsAStateNotAPass(t *testing.T) {
	n := &Native{}
	rep, err := n.Validate(context.Background(), Request{
		Set:       &yangschema.Set{},
		Documents: []Document{{File: "a.yaml", Format: "yaml", Content: []byte("a: 1")}},
	})
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if rep.Available {
		t.Error("a repository with no models reported that full validation ran")
	}
	if rep.Reason == "" {
		t.Error("an unavailable validator has to explain itself")
	}
}
