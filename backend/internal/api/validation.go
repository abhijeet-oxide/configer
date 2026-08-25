package api

// The pre-submit validation gate, and the status panel that says what it can
// actually check here.
//
// Two tiers run, in this order, because they answer different questions and
// the cheap one answers first:
//
//  1. Every staged value against its own rules (validate.Value), which is the
//     same check the cell editor makes. It runs again because a draft can be
//     staged over minutes while the catalog moves underneath it, and because a
//     direct file edit never went through a cell editor at all.
//  2. The whole candidate document against the YANG models (yangvalidate),
//     which is the only place the cross-value questions have an answer: a
//     mandatory leaf left out, two entries colliding on a key, a reference
//     pointing at nothing, a "must" condition spanning three settings.
//
// A blocking finding refuses the submit. That is the whole point of the tier -
// but it is refused with the findings attached, named the way the person who
// made the change would recognize them, so "fix it" is a click rather than an
// investigation.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/changeset"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/validate"
	"github.com/abhijeet-oxide/configer/backend/internal/yangvalidate"
)

// ValidationStatus is what this deployment can check, for the panel that says
// so. It exists because "your change is valid" and "nothing checked your
// change" look identical from a browser, and only one of them is worth
// believing.
type ValidationStatus struct {
	// SchemaDetected: the repository ships YANG models at all.
	SchemaDetected bool `json:"schemaDetected"`
	// Modules and Nodes size what was read.
	Modules int `json:"modules"`
	Nodes   int `json:"nodes"`
	// SchemaDirs are the repo-relative directories the models came from, and
	// SchemaVersion the release they were selected for.
	SchemaDirs    []string `json:"schemaDirs,omitempty"`
	SchemaVersion string   `json:"schemaVersion,omitempty"`
	// Engine is what would run a full-document validation, Available whether it
	// can, and Reason why not in words an operator can act on.
	Engine    string `json:"engine,omitempty"`
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	// EngineVersion is the external validator's own version string, when there
	// is one.
	EngineVersion string `json:"engineVersion,omitempty"`
	// Engines lists every validator this build knows about and whether each is
	// usable here, so an operator can see what installing something would buy.
	Engines []EngineStatus `json:"engines"`
}

// EngineStatus is one validator's availability.
type EngineStatus struct {
	Name      string `json:"name"`
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

// validationStatus reports what validation this deployment can perform.
//
// @Summary     Validation capability
// @Description What this deployment can check before a change is submitted: whether the repository ships YANG models, how many were read, which full-document validator is available (and why one is not), and the release the models were selected for. The UI uses it to say what was actually checked instead of implying a change is fully model-valid when nothing looked.
// @Tags        Editing & change requests
// @Produce     json
// @Success     200 {object} ValidationStatus
// @Router      /api/validation/status [get]
func (s *Server) validationStatus(w http.ResponseWriter, r *http.Request) {
	set, dirs, version := s.models()
	out := ValidationStatus{
		SchemaDetected: set != nil,
		SchemaDirs:     dirs,
		SchemaVersion:  version,
		Engines:        []EngineStatus{},
	}
	if set != nil {
		out.Modules, out.Nodes = modelFileCount(s.RepoPath, dirs), set.Nodes()
	}
	for _, e := range yangvalidate.Engines() {
		ok, why := e.Available()
		out.Engines = append(out.Engines, EngineStatus{Name: e.Name(), Available: ok, Reason: why})
	}
	engine, available, why := yangvalidate.Select()
	if engine != nil {
		out.Engine = engine.Name()
	}
	// A validator with nothing to validate against is not available, whatever
	// the binary situation is.
	out.Available = available && set != nil
	switch {
	case why != "":
		out.Reason = why
	case set == nil:
		out.Reason = "this repository ships no YANG models, so only the rules in the parameter catalog apply"
	}
	if out.Engine == "yanglint" && available {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		out.EngineVersion = yangvalidate.Version(ctx)
	}
	writeJSON(w, http.StatusOK, out)
}

// startValidation begins validating a change request and returns immediately.
//
// @Summary     Validate a change request
// @Description Start a pre-submit validation of a change request: every staged value against its rules, then the whole candidate document against the repository's YANG models. Returns 202 with the run resource; poll `GET /api/changes/{id}/validation` for its stages, findings and verdict. Nothing is written, branched or committed.
// @Tags        Editing & change requests
// @Produce     json
// @Param       id path int true "Change request id"
// @Success     202 {object} ValidationRun
// @Failure     400 {object} APIError "Invalid id"
// @Failure     404 {object} APIError "Unknown change request"
// @Router      /api/changes/{id}/validation [post]
func (s *Server) startValidation(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid id")
		return
	}
	cr, err := s.Store.Get(id)
	if err != nil {
		writeError(w, r, http.StatusNotFound, CodeNotFound, err.Error())
		return
	}
	run := newRun(id, fingerprintOf(cr))
	s.validations.put(run)
	// The work outlives this request on purpose: the client polls the run, and
	// a browser that navigates away must not cancel a validation somebody else
	// is waiting on. It carries its own deadline instead.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), validationTimeout)
		defer cancel()
		s.runValidation(ctx, run.ID, cr)
	}()
	writeJSON(w, http.StatusAccepted, run)
}

// getValidation returns a run's current state.
//
// @Summary     Validation run state
// @Description The latest validation run for a change request: its stages, what each one found, and the verdict. Poll while `state` is "running". Returns 404 when the change has never been validated.
// @Tags        Editing & change requests
// @Produce     json
// @Param       id  path  int    true  "Change request id"
// @Param       run query string false "A specific run id; defaults to the latest for this change"
// @Success     200 {object} ValidationRun
// @Failure     404 {object} APIError "No validation has been run"
// @Router      /api/changes/{id}/validation [get]
func (s *Server) getValidation(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid id")
		return
	}
	if runID := r.URL.Query().Get("run"); runID != "" {
		if run, found := s.validations.get(runID); found {
			writeJSON(w, http.StatusOK, run)
			return
		}
		writeError(w, r, http.StatusNotFound, CodeNotFound, "that validation is no longer available; start a new one")
		return
	}
	run, found := s.validations.latestFor(id)
	if !found {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "this change has not been validated yet")
		return
	}
	writeJSON(w, http.StatusOK, run)
}

// validationTimeout bounds a whole run. A model set of several hundred modules
// over a fleet-sized change is seconds; past this something is wrong, and a
// gate that never answers is worse than one that says it ran out of time.
const validationTimeout = 3 * time.Minute

// runValidation is the worker. Every stage records what it did, because a
// stage that reports only "passed" cannot be told from one that did nothing.
func (s *Server) runValidation(ctx context.Context, runID string, cr *change.ChangeRequest) {
	set := func(id, state, detail string) {
		s.validations.update(runID, func(run *ValidationRun) {
			st := run.stage(id)
			if st == nil {
				return
			}
			if state == StageRunning {
				st.StartedAt = nowStamp()
			} else if st.EndedAt == "" {
				st.EndedAt = nowStamp()
			}
			st.State, st.Detail = state, detail
		})
	}
	fail := func(state string) {
		s.validations.update(runID, func(run *ValidationRun) {
			run.State, run.EndedAt = state, nowStamp()
			for i := range run.Stages {
				if run.Stages[i].State == StagePending {
					run.Stages[i].State = StageSkipped
					run.Stages[i].Detail = "not reached"
				}
			}
		})
	}

	// 1) What is in the change.
	set(StageCollect, StageRunning, "")
	set(StageCollect, StagePassed, countPhrase(len(cr.Items), "change", "changes")+
		" across "+countPhrase(len(cr.Instances()), "instance", "instances"))

	// 2) Every staged value against its own rules.
	set(StageRules, StageRunning, "")
	ruleFindings, checked := s.checkStagedValues(cr)
	s.addFindings(runID, ruleFindings)
	if hasErrors(ruleFindings) {
		set(StageRules, StageFailed, problemPhrase(ruleFindings))
	} else {
		set(StageRules, StagePassed, countPhrase(checked, "value", "values")+" checked")
	}

	// 3) The bytes this change would actually commit. Reusing Preview means the
	//    thing validated is the thing committed, rather than a reconstruction of
	//    it that can drift.
	set(StageBuild, StageRunning, "")
	preview, err := s.Changes.Preview(ctx, cr.ID)
	if err != nil {
		set(StageBuild, StageFailed, "the files could not be built: "+err.Error())
		fail(RunError)
		return
	}
	s.validations.update(runID, func(run *ValidationRun) {
		run.Problems = append(run.Problems, preview.Problems...)
	})
	if len(preview.Problems) > 0 {
		set(StageBuild, StageFailed, countPhrase(len(preview.Problems), "edit", "edits")+" could not be applied")
	} else {
		set(StageBuild, StagePassed, countPhrase(len(preview.Files), "file", "files")+" rewritten")
	}

	// 4) The whole document against the models.
	set(StageModel, StageRunning, "")
	report := s.validateDocuments(ctx, preview)
	s.addFindings(runID, report.Findings)
	s.validations.update(runID, func(run *ValidationRun) {
		run.Engine, run.Available, run.Reason = report.Engine, report.Available, report.Reason
		run.Documents, run.Values, run.Unmatched = report.Documents, report.Values, report.Unmatched
		run.Skipped = append(run.Skipped, report.Skipped...)
	})
	switch {
	case !report.Available:
		set(StageModel, StageSkipped, report.Reason)
	case len(report.Errors()) > 0:
		set(StageModel, StageFailed, problemPhrase(report.Findings))
	default:
		set(StageModel, StagePassed, modelPhrase(report))
	}

	s.validations.update(runID, func(run *ValidationRun) {
		run.EndedAt = nowStamp()
		if run.OK() {
			run.State = RunPassed
			return
		}
		run.State = RunFailed
	})
}

// addFindings records findings and keeps the error/warning tallies in step, so
// no caller can update one without the other.
func (s *Server) addFindings(runID string, found []yangvalidate.Finding) {
	if len(found) == 0 {
		return
	}
	s.validations.update(runID, func(run *ValidationRun) {
		run.Findings = append(run.Findings, found...)
		run.Errors, run.Warnings = 0, 0
		for _, f := range run.Findings {
			if f.Severity == yangvalidate.SeverityError {
				run.Errors++
				continue
			}
			run.Warnings++
		}
	})
}

// checkStagedValues holds each staged value against its parameter's rules.
//
// The cell editor already did this when the value was typed, and it is done
// again here because the two moments are not the same moment: a draft can sit
// for a day while somebody else tightens a rule, imports a schema, or removes
// the parameter entirely. Validating at submit is what makes the rule that is
// true NOW the rule that decides.
func (s *Server) checkStagedValues(cr *change.ChangeRequest) ([]yangvalidate.Finding, int) {
	p, err := s.load()
	if err != nil {
		return nil, 0
	}
	byID := map[string]model.Parameter{}
	for _, param := range p.Catalog.Parameters {
		byID[param.ID] = param
	}
	var out []yangvalidate.Finding
	checked := 0
	for _, it := range cr.Items {
		if it.Action != change.ActionSet || it.ParamID == "" {
			continue
		}
		param, found := byID[it.ParamID]
		if !found {
			out = append(out, yangvalidate.Finding{
				Severity: yangvalidate.SeverityError, Rule: yangvalidate.RuleSchema,
				ParamID: it.ParamID, Instance: it.Instance, Engine: "catalog",
				Message: "this setting is no longer in the catalog, so the change cannot be applied to it",
			})
			continue
		}
		checked++
		display := param.DisplayName
		if display == "" {
			display = param.Name
		}
		coerced, cerr := validate.CoerceValue(param, it.New)
		if cerr != nil {
			out = append(out, yangvalidate.Finding{
				Severity: yangvalidate.SeverityError, Rule: yangvalidate.RuleType,
				ParamID: param.ID, Name: display, Instance: it.Instance, Engine: "catalog",
				Message: cerr.Error(), Schema: param.Validation.SchemaRef,
			})
			continue
		}
		if res := validate.Value(param, coerced); !res.Valid {
			out = append(out, yangvalidate.Finding{
				Severity: yangvalidate.SeverityError, Rule: yangvalidate.RuleType,
				ParamID: param.ID, Name: display, Instance: it.Instance, Engine: "catalog",
				Message: res.Message, Schema: param.Validation.SchemaRef,
			})
		}
	}
	return out, checked
}

// validateDocuments holds every file the change would rewrite against the
// models.
//
// Only the changed files are validated, and that is a deliberate limit worth
// stating: a repository whose committed state already breaks a rule is not this
// change's fault, and reporting it here would make every submit carry somebody
// else's backlog. What a change is answerable for is the state it leaves the
// files it touched in - which is exactly the candidate content Preview built.
func (s *Server) validateDocuments(ctx context.Context, preview *changeset.PreviewResult) yangvalidate.Report {
	set, dirs, _ := s.models()
	if set == nil {
		return yangvalidate.Report{Available: false, Findings: []yangvalidate.Finding{},
			Reason: "this repository ships no YANG models, so only the rules in the parameter catalog apply"}
	}
	var instances []model.Instance
	if p, err := s.load(); err == nil {
		instances = p.Registry.Instances
	}
	var docs []yangvalidate.Document
	for _, f := range preview.Files {
		// A removed file has nothing left to validate, and a format nothing can
		// parse (a README, a certificate) was never a document in the first
		// place.
		format := formatOf(f.File)
		if f.After == "" || format == "" {
			continue
		}
		docs = append(docs, yangvalidate.Document{
			File: f.File, Format: format, Instance: instanceOf(instances, f.File),
			Content: []byte(f.After),
		})
	}
	if len(docs) == 0 {
		return yangvalidate.Report{Available: false, Findings: []yangvalidate.Finding{},
			Reason: "this change rewrites no configuration document a model could describe"}
	}
	return yangvalidate.Run(ctx, yangvalidate.Request{
		Set: set, Documents: docs,
		SchemaRoot: s.RepoPath, SchemaDirs: dirs,
		Locate: s.locator(),
	})
}

// formatOf names the parseable format of a file, empty when it is not one.
// A README is not malformed YAML; it was never YAML.
func formatOf(file string) string {
	lower := strings.ToLower(file)
	switch {
	case strings.HasSuffix(lower, ".yaml"), strings.HasSuffix(lower, ".yml"):
		return "yaml"
	case strings.HasSuffix(lower, ".json"):
		return "json"
	case strings.HasSuffix(lower, ".xml"):
		return "xml"
	}
	return ""
}

func hasErrors(f []yangvalidate.Finding) bool {
	for _, x := range f {
		if x.Severity == yangvalidate.SeverityError {
			return true
		}
	}
	return false
}

func problemPhrase(f []yangvalidate.Finding) string {
	n := 0
	for _, x := range f {
		if x.Severity == yangvalidate.SeverityError {
			n++
		}
	}
	return countPhrase(n, "problem", "problems") + " found"
}

func modelPhrase(rep yangvalidate.Report) string {
	out := countPhrase(rep.Values, "value", "values") + " checked against the model in " +
		countPhrase(rep.Documents, "file", "files")
	if len(rep.Skipped) > 0 {
		out += ", " + countPhrase(len(rep.Skipped), "check", "checks") + " passed over"
	}
	return out
}

func countPhrase(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

// validationGate is what stands between a draft and a branch.
//
// It reuses a run the client already watched when that run validated THIS
// draft (the fingerprint proves it) and passed; otherwise it validates
// synchronously here. A client that skips the endpoint entirely - a script, an
// old build, somebody with curl - gets the same gate, because a check the
// caller can opt out of is not a check.
func (s *Server) validationGate(ctx context.Context, cr *change.ChangeRequest) *ValidationRun {
	fingerprint := fingerprintOf(cr)
	if latest, found := s.validations.latestFor(cr.ID); found &&
		latest.Fingerprint == fingerprint && latest.State == RunPassed {
		return latest
	}
	run := newRun(cr.ID, fingerprint)
	s.validations.put(run)
	s.runValidation(ctx, run.ID, cr)
	out, _ := s.validations.get(run.ID)
	return out
}

// writeValidationRefusal answers a submit the gate refused, with everything
// needed to fix it rather than just the fact of the refusal.
func writeValidationRefusal(w http.ResponseWriter, r *http.Request, run *ValidationRun) {
	body := map[string]any{
		"error":      "validation_failed",
		"code":       CodeValidationFailed,
		"message":    refusalMessage(run),
		"validation": run,
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnprocessableEntity)
	_ = json.NewEncoder(w).Encode(body)
}

// overrideNote records, in the change's own description, that it was submitted
// over the gate's objections and why.
//
// This is the whole reason an override is allowed at all. The alternative to a
// recorded override is not "no overrides" - it is somebody switching the
// validator off in an environment variable, which nobody reviewing the change
// will ever see. Written here it travels into the commit message and the pull
// request body, where the approver reads it before publishing.
func overrideNote(description string, run *ValidationRun, reason string) string {
	note := "Submitted over validation: " + refusalMessage(run) + "."
	if reason = strings.TrimSpace(reason); reason != "" {
		note += " Reason given: " + reason
	}
	if strings.TrimSpace(description) == "" {
		return note
	}
	return description + "\n\n" + note
}

// refusalMessage says what is wrong in one sentence, in the reader's terms.
func refusalMessage(run *ValidationRun) string {
	switch {
	case run == nil:
		return "the change could not be validated"
	case run.State == RunError:
		return "the change could not be validated, so it was not submitted"
	case len(run.Problems) > 0 && run.Errors > 0:
		return fmt.Sprintf("%s could not be applied and %s does not match the data model",
			countPhrase(len(run.Problems), "edit", "edits"),
			countPhrase(run.Errors, "change", "changes"))
	case len(run.Problems) > 0:
		return countPhrase(len(run.Problems), "edit", "edits") + " could not be applied to the files"
	default:
		return countPhrase(run.Errors, "change", "changes") + " does not match what the data model allows"
	}
}
