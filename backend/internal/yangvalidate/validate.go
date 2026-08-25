// Package yangvalidate is the SECOND validation tier: it holds a whole
// candidate document against the YANG models a repository ships, rather than
// one value against the rules extracted from them.
//
// The two tiers answer different questions and neither replaces the other.
// Tier one (yangschema -> model.Validation -> validate.Value) asks "is this
// value a legal value for this setting", which is what an editor needs while
// somebody types and what every write path enforces. It cannot ask the
// questions that only have an answer once the whole file exists: whether a
// mandatory leaf was left out, whether two list entries collide on their key,
// whether a reference points at something that is there, whether a "must"
// condition comparing three leaves still holds. Those are what this package is
// for, and they are checked at SUBMIT, when the change is complete and about to
// become somebody else's problem.
//
// A missing validator is a STATE, not a failure. Report.Available says whether
// full validation actually ran; reporting success when nothing ran would
// quietly turn the gate off on every machine that has not installed anything.
package yangvalidate

import (
	"context"
	"os"
	"strings"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/yangschema"
)

// Severity levels. A warning is reported and does not block; an error does.
const (
	SeverityError   = "error"
	SeverityWarning = "warning"
)

// Rule names the kind of check that produced a finding, so the UI can group
// them and a reader can tell a typo from a structural mistake.
const (
	RuleType      = "type"
	RuleMandatory = "mandatory"
	RuleKey       = "key"
	RuleUnique    = "unique"
	RuleLeafref   = "leafref"
	RuleMust      = "must"
	RuleWhen      = "when"
	RuleChoice    = "choice"
	RuleCount     = "count"
	RuleFeature   = "feature"
	RuleStatus    = "status"
	RuleSchema    = "schema"
)

// Finding is one problem in a candidate document, named the way the person who
// made the change would recognize it.
type Finding struct {
	Severity string `json:"severity"`
	Rule     string `json:"rule"`
	// File is repo-relative; Path is the route inside it, in the same spelling
	// the editor uses to open a value.
	File string `json:"file,omitempty"`
	Path string `json:"path,omitempty"`
	Line int    `json:"line,omitempty"`
	// Instance is the deployment target the file belongs to, empty for a
	// shared file.
	Instance string `json:"instance,omitempty"`
	// ParamID is the catalog parameter this lands on, when one can be
	// identified. It is what lets the UI offer "open this setting" rather than
	// "here is a path in a file".
	ParamID string `json:"paramId,omitempty"`
	// Name is the human name of the setting, for a message a non-engineer can
	// read.
	Name string `json:"name,omitempty"`
	// Message is written for the person who has to fix it, in words, never in
	// XPath. Detail carries the schema's own expression for the reader who
	// wants it.
	Message string `json:"message"`
	Detail  string `json:"detail,omitempty"`
	// Schema names the model file the rule came from, so a vendor's constraint
	// is never presented as the product's opinion.
	Schema string `json:"schema,omitempty"`
	// Engine names what produced the finding, because "yanglint says so" and
	// "our own reading says so" are different weights of evidence.
	Engine string `json:"engine,omitempty"`
}

// Document is one candidate configuration file: the content a change WOULD
// commit, not what is on disk.
type Document struct {
	File     string
	Format   string
	Instance string
	Content  []byte
}

// Request is one validation run.
type Request struct {
	Set       *yangschema.Set
	Documents []Document
	// SchemaRoot is the absolute path models were read from, which is what an
	// external validator needs to be pointed at.
	SchemaRoot string
	SchemaDirs []string
	// Locate maps a (file, path) pair to the catalog parameter that manages it,
	// so a finding lands on the row the user actually edited. Optional.
	Locate func(file, path string) (paramID, name string, ok bool)
	// Progress, when set, is called as the run moves through its documents so
	// a caller can report live status instead of a frozen screen.
	Progress func(Progress)
}

// Progress is one step of a run in flight.
type Progress struct {
	// Done and Total count documents.
	Done, Total int
	// File is the document being read right now.
	File string
	// Findings is how many problems have been found so far.
	Findings int
}

// Report is the outcome of a run.
type Report struct {
	// Engine names what ran ("native", "yanglint"), or is empty when nothing
	// did.
	Engine string `json:"engine,omitempty"`
	// Available is false when no full-document validator could run here. It is
	// NOT the same as "no findings": a caller that treats them alike has turned
	// the gate off without noticing.
	Available bool `json:"available"`
	// Reason explains an unavailable validator in words an operator can act on.
	Reason    string    `json:"reason,omitempty"`
	Findings  []Finding `json:"findings"`
	Documents int       `json:"documents"`
	// Values counts the leaves actually held against a model node, which is
	// what says whether the run meant anything.
	Values int `json:"values"`
	// Unmatched counts document leaves no model node claimed. A high count on a
	// repository that ships models usually means the file is not modelled at
	// all, which is worth SAYING rather than reporting as a clean pass.
	Unmatched  int      `json:"unmatched"`
	Skipped    []string `json:"skipped,omitempty"`
	DurationMS int64    `json:"durationMs"`
}

// Errors returns only the blocking findings.
func (r Report) Errors() []Finding {
	var out []Finding
	for _, f := range r.Findings {
		if f.Severity == SeverityError {
			out = append(out, f)
		}
	}
	return out
}

// OK reports whether the run found nothing blocking. An unavailable validator
// is OK: it did not find a problem, and it never claimed to have looked.
func (r Report) OK() bool { return len(r.Errors()) == 0 }

// Engine is one full-document validator.
type Engine interface {
	// Name is the identifier reported to operators and shown in the UI.
	Name() string
	// Available reports whether this engine can run here, with a sentence
	// explaining why not when it cannot.
	Available() (bool, string)
	Validate(ctx context.Context, req Request) (Report, error)
}

// Engines returns every engine this build knows about, most capable first.
// The order matters: an external validator that implements the whole language
// outranks our own reading of it wherever both can run.
func Engines() []Engine {
	return []Engine{&Yanglint{}, &Native{}}
}

// Select chooses the engine to run.
//
// CONFIGER_YANG_VALIDATOR overrides the choice: a name picks that engine (and
// reports it unavailable rather than falling back, because a deployment that
// named yanglint wants to know when it is missing), and "off" disables the
// tier entirely for a deployment that has its own gate elsewhere.
func Select() (Engine, bool, string) {
	want := strings.ToLower(strings.TrimSpace(os.Getenv("CONFIGER_YANG_VALIDATOR")))
	switch want {
	case "off", "none", "disabled":
		return nil, false, "full model validation is switched off for this deployment"
	case "", "auto":
		for _, e := range Engines() {
			if ok, _ := e.Available(); ok {
				return e, true, ""
			}
		}
		return nil, false, "no full-document validator is available here"
	}
	for _, e := range Engines() {
		if e.Name() != want {
			continue
		}
		ok, why := e.Available()
		return e, ok, why
	}
	return nil, false, "no validator called " + want + " is built into this version"
}

// Run validates a request with the selected engine, or explains why nothing
// ran. It never returns an error for an absent validator: that is a state the
// caller reports, not a failure it has to handle.
func Run(ctx context.Context, req Request) Report {
	start := time.Now()
	engine, available, why := Select()
	if !available {
		return Report{Available: false, Reason: why, Findings: []Finding{},
			Documents: len(req.Documents), DurationMS: time.Since(start).Milliseconds()}
	}
	rep, err := engine.Validate(ctx, req)
	rep.Engine = engine.Name()
	rep.DurationMS = time.Since(start).Milliseconds()
	if rep.Findings == nil {
		rep.Findings = []Finding{}
	}
	if err != nil {
		// An engine that broke has NOT validated anything. Saying so is the
		// only honest answer; reporting a clean pass would be a lie with a
		// device on the other end of it.
		rep.Available = false
		rep.Reason = "the validator could not run: " + err.Error()
	}
	return rep
}
