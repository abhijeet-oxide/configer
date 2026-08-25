package api

// The gate, end to end: a change that breaks a rule the models state is
// refused before a branch exists, and the refusal carries what is wrong and
// where.

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// modelRepo is a repository that ships a YANG model, so both validation tiers
// have something to say.
func modelRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, content string) {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(".configer/application.yaml", "apiVersion: configer.io/v1\nkind: Application\nname: t\nlayout: plain-folders\n")
	write(".configer/parameters.yaml", `
apiVersion: configer.io/v1
kind: ParameterCatalog
parameters:
  - id: cell-power
    name: radio.cell.power
    category: Radio
    type: integer
    scope: instance
    bindings:
      - { file: "{folder}/values.yaml", path: "$.radio.cell[0].power", format: yaml }
  - id: cell-name
    name: radio.cell.name
    category: Radio
    type: string
    scope: instance
    bindings:
      - { file: "{folder}/values.yaml", path: "$.radio.cell[0].name", format: yaml }
`)
	write(".configer/instances.yaml", "apiVersion: configer.io/v1\nkind: InstanceRegistry\ninstances:\n  - { name: site-a, folder: instances/site-a }\n")
	write("instances/site-a/values.yaml", "radio:\n  cell:\n    - name: alpha\n      power: 20\n      neighbour: [beta]\n")
	write("models/acme-radio.yang", `module acme-radio {
    namespace "http://example.com/acme-radio";
    prefix acme;
    container radio {
        list cell {
            key "name";
            must "count(./neighbour) > 0" {
                error-message "A cell needs at least one neighbour.";
            }
            leaf name { type string { length "1..8"; } }
            leaf power {
                units "dBm";
                type int16 {
                    range "-30..46" {
                        error-message "Transmit power must sit between -30 and 46 dBm.";
                    }
                }
            }
            leaf-list neighbour { type string; min-elements 1; }
        }
    }
}`)
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"}, {"add", "-A"},
		{"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	return root
}

// stageAndValidate stages one value edit and runs a validation to completion,
// returning the finished run.
func stageAndValidate(t *testing.T, h http.Handler, paramID string, value any) ValidationRun {
	t.Helper()
	doJSON(t, h, http.MethodPut, "/api/values", map[string]any{
		"paramId": paramID, "instance": "site-a", "value": value, "author": "alice",
	}, nil)
	var draft struct {
		Draft struct {
			ID int `json:"id"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)
	if draft.Draft.ID == 0 {
		t.Fatal("no draft after staging an edit")
	}
	path := "/api/changes/" + itoa(draft.Draft.ID) + "/validation"
	var run ValidationRun
	// 202: the run is accepted and continues in the background, which is the
	// whole point of it being a resource.
	rec := doRaw(t, h, http.MethodPost, path, map[string]any{})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("start validation: want 202, got %d (%s)", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &run); err != nil {
		t.Fatal(err)
	}

	// The run is asynchronous on purpose - the client watches it happen rather
	// than waiting on a frozen screen - so the test waits the same way.
	deadline := time.Now().Add(60 * time.Second)
	for run.State == RunRunning && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
		doJSON(t, h, http.MethodGet, path, nil, &run)
	}
	if run.State == RunRunning {
		t.Fatal("validation never finished")
	}
	return run
}

func TestValidationStatusSaysWhatItCanCheck(t *testing.T) {
	s, err := New(modelRepo(t))
	if err != nil {
		t.Fatal(err)
	}
	var status ValidationStatus
	doJSON(t, s.Routes(), http.MethodGet, "/api/validation/status", nil, &status)

	if !status.SchemaDetected {
		t.Fatal("the repository ships a YANG model and the status says it does not")
	}
	if status.Modules != 1 || status.Nodes == 0 {
		t.Errorf("modules/nodes = %d/%d, want the one module it ships", status.Modules, status.Nodes)
	}
	if !status.Available {
		t.Errorf("no validator is available: %s", status.Reason)
	}
	// Every engine is listed whether or not it can run here, so an operator can
	// see what installing one would buy.
	if len(status.Engines) < 2 {
		t.Errorf("engines = %v, want every validator this build knows about", status.Engines)
	}
}

func TestValidationStatusOnARepositoryWithNoModels(t *testing.T) {
	s, err := New(minimalRepo(t))
	if err != nil {
		t.Fatal(err)
	}
	var status ValidationStatus
	doJSON(t, s.Routes(), http.MethodGet, "/api/validation/status", nil, &status)

	if status.SchemaDetected {
		t.Error("models were reported for a repository that ships none")
	}
	// "Nothing to validate against" must never read as "validated".
	if status.Available {
		t.Error("full validation reported available with nothing to validate against")
	}
	if status.Reason == "" {
		t.Error("an unavailable validator has to explain itself")
	}
}

func TestAValidChangePassesEveryStage(t *testing.T) {
	s, err := New(modelRepo(t))
	if err != nil {
		t.Fatal(err)
	}
	run := stageAndValidate(t, s.Routes(), "cell-power", 30)

	if run.State != RunPassed {
		t.Fatalf("state = %s, findings = %+v", run.State, run.Findings)
	}
	for _, st := range run.Stages {
		if st.State != StagePassed {
			t.Errorf("stage %s = %s (%s), want passed", st.ID, st.State, st.Detail)
		}
		if st.Detail == "" {
			t.Errorf("stage %s reported no detail, so the reader cannot tell it did anything", st.ID)
		}
	}
	if run.Values == 0 {
		t.Error("no values were checked against the model, so the pass means nothing")
	}
}

// The range is stated by the model, not by the catalog: the catalog says
// "integer" and nothing else. Refusing this is the whole point of reading the
// models.
func TestAValueOutsideTheModelsRangeIsRefused(t *testing.T) {
	s, err := New(modelRepo(t))
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()
	run := stageAndValidate(t, h, "cell-power", 500)

	if run.State != RunFailed || run.Errors == 0 {
		t.Fatalf("state = %s errors = %d, want the out-of-range value refused", run.State, run.Errors)
	}
	f := run.Findings[0]
	if f.Message != "Transmit power must sit between -30 and 46 dBm." {
		t.Errorf("message = %q, want the model's own wording", f.Message)
	}
	// A finding nobody can act on is a finding nobody acts on.
	if f.ParamID != "cell-power" {
		t.Errorf("paramId = %q, want the row the user edited", f.ParamID)
	}
	if f.File == "" || f.Line == 0 {
		t.Errorf("finding has no place in the file: %+v", f)
	}

	// And the submit is refused, with the run attached rather than a bare 422.
	var draft struct {
		Draft struct {
			ID int `json:"id"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)
	rec := doRaw(t, h, http.MethodPost, "/api/changes/"+itoa(draft.Draft.ID)+"/submit",
		map[string]any{"title": "raise the power"})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("submit: want 422, got %d (%s)", rec.Code, rec.Body.String())
	}
	var refusal struct {
		Code       string        `json:"code"`
		Message    string        `json:"message"`
		Validation ValidationRun `json:"validation"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &refusal); err != nil {
		t.Fatal(err)
	}
	if refusal.Validation.Errors == 0 {
		t.Error("the refusal carried no findings, so the user has nothing to fix")
	}
	if refusal.Message == "" {
		t.Error("the refusal said nothing in words")
	}
}

// A submit that never asks for validation still gets it. A gate a caller can
// skip by not calling an endpoint is not a gate.
func TestSubmitValidatesEvenWhenTheClientNeverAsked(t *testing.T) {
	s, err := New(modelRepo(t))
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()
	doJSON(t, h, http.MethodPut, "/api/values", map[string]any{
		"paramId": "cell-power", "instance": "site-a", "value": 500, "author": "alice",
	}, nil)
	var draft struct {
		Draft struct {
			ID int `json:"id"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)

	rec := doRaw(t, h, http.MethodPost, "/api/changes/"+itoa(draft.Draft.ID)+"/submit",
		map[string]any{"title": "raise the power"})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422 without ever calling the validation endpoint, got %d (%s)", rec.Code, rec.Body.String())
	}
}

// An override is allowed and RECORDED. The alternative to a recorded override
// is somebody turning the validator off where no reviewer will ever see it.
func TestOverrideSubmitsAndSaysSoInTheChange(t *testing.T) {
	s, err := New(modelRepo(t))
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()
	doJSON(t, h, http.MethodPut, "/api/values", map[string]any{
		"paramId": "cell-power", "instance": "site-a", "value": 500, "author": "alice",
	}, nil)
	var draft struct {
		Draft struct {
			ID int `json:"id"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)

	var cr struct {
		Description string `json:"description"`
		State       string `json:"state"`
	}
	rec := doRaw(t, h, http.MethodPost, "/api/changes/"+itoa(draft.Draft.ID)+"/submit", map[string]any{
		"title": "raise the power", "override": true, "overrideReason": "lab rig, vendor confirmed",
	})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("override submit: want 202, got %d (%s)", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &cr); err != nil {
		t.Fatal(err)
	}
	if cr.State != "under_review" {
		t.Fatalf("state = %q, want the override to have gone through", cr.State)
	}
	if !strings.Contains(cr.Description, "Submitted over validation") {
		t.Errorf("description = %q, want it to record the override", cr.Description)
	}
	if !strings.Contains(cr.Description, "lab rig") {
		t.Errorf("description = %q, want the reason the author gave", cr.Description)
	}
}
