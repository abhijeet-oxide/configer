package api

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// mixedScopeRepo is a committed repo whose settings are NOT all one scope: a
// shared file every instance reads, plus each instance's own values. That is
// what a group of related settings actually looks like, and it is what the
// batch endpoint has to be able to save in one go.
func mixedScopeRepo(t *testing.T) string {
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
  - id: p-domain
    name: net.domain
    category: Networking
    type: string
    scope: global
    bindings:
      - { file: "base/values.yaml", path: $.net.domain, format: yaml }
  - id: p-port
    name: net.port
    category: Networking
    type: integer
    scope: instance
    bindings:
      - { file: "{folder}/values.yaml", path: $.net.port, format: yaml }
  - id: p-host
    name: net.host
    category: Networking
    type: string
    scope: instance
    bindings:
      - { file: "{folder}/values.yaml", path: $.net.host, format: yaml }
`)
	write(".configer/instances.yaml", "apiVersion: configer.io/v1\nkind: InstanceRegistry\ninstances:\n  - { name: east, folder: instances/east, site: dallas }\n  - { name: west, folder: instances/west, site: oakland }\n")
	write("base/values.yaml", "net:\n  domain: example.com\n")
	write("instances/east/values.yaml", "net:\n  port: 8080\n  host: east.example.com\n")
	write("instances/west/values.yaml", "net:\n  port: 8080\n  host: west.example.com\n")
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

type batchResponse struct {
	Staged  int `json:"staged"`
	Results []struct {
		ParamID  string `json:"paramId"`
		Instance string `json:"instance"`
		Scope    string `json:"scope"`
		OK       bool   `json:"ok"`
		Error    string `json:"error"`
	} `json:"results"`
}

// A group of settings saves as ONE request: several parameters, several
// instances, and a global value among them.
func TestBatchStagesSeveralParametersAndAGlobalTogether(t *testing.T) {
	root := mixedScopeRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	var resp batchResponse
	doJSON(t, h, http.MethodPut, "/api/values/bulk", map[string]any{
		"edits": []map[string]any{
			{"paramId": "p-domain", "scope": "global", "value": "acme.net"},
			{"paramId": "p-port", "instance": "east", "value": 9090},
			{"paramId": "p-port", "instance": "west", "value": 9091},
			{"paramId": "p-host", "instance": "east", "value": "e1.acme.net"},
		},
	}, &resp)

	if resp.Staged != 4 {
		t.Fatalf("staged = %d, want 4; results %+v", resp.Staged, resp.Results)
	}
	items := draftItems(t, h)
	if len(items) != 4 {
		t.Fatalf("draft holds %d items, want 4: %+v", len(items), items)
	}
	// The global edit carries no instance: it is one value in the shared file,
	// not one edit per system.
	globals := 0
	for _, it := range items {
		if it.ParamID == "p-domain" {
			globals++
			if it.Instance != "" {
				t.Errorf("a global edit named an instance (%q)", it.Instance)
			}
			if it.New != "acme.net" {
				t.Errorf("global value = %v, want acme.net", it.New)
			}
		}
	}
	if globals != 1 {
		t.Errorf("staged %d global items, want exactly 1", globals)
	}
}

// One bad edit in a batch does not refuse the rest: the good ones stage and the
// failure is reported against the edit that caused it. A save that is all or
// nothing at this layer means one typo throws away nineteen correct values.
func TestBatchReportsPerEditFailuresAndStagesTheRest(t *testing.T) {
	root := mixedScopeRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	var resp batchResponse
	doJSON(t, h, http.MethodPut, "/api/values/bulk", map[string]any{
		"edits": []map[string]any{
			{"paramId": "p-port", "instance": "east", "value": 9090},
			{"paramId": "p-port", "instance": "east", "value": "not-a-number"},
			{"paramId": "p-ghost", "instance": "east", "value": 1},
			// A per-instance edit of a setting that lives only in the shared
			// file: refused with the advice to change it for everyone.
			{"paramId": "p-domain", "instance": "east", "value": "x.net"},
		},
	}, &resp)

	byParam := map[string]string{}
	for _, r := range resp.Results {
		if r.Error != "" {
			byParam[r.ParamID] = r.Error
		}
	}
	if byParam["p-ghost"] == "" {
		t.Errorf("an unknown parameter should fail its own edit, not the request")
	}
	if byParam["p-domain"] == "" {
		t.Errorf("a per-instance edit of a shared-file setting should be refused")
	}
	items := draftItems(t, h)
	if len(items) != 1 || items[0].ParamID != "p-port" {
		t.Fatalf("the valid edit should still be staged, got %+v", items)
	}
}

// A global value cannot be "reset": dropping an override is a per-instance act,
// and there is no override to drop on a value that only exists once.
func TestBatchRefusesResettingAGlobalValue(t *testing.T) {
	root := mixedScopeRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	var resp batchResponse
	doJSON(t, h, http.MethodPut, "/api/values/bulk", map[string]any{
		"action": "reset",
		"edits":  []map[string]any{{"paramId": "p-domain", "scope": "global"}},
	}, &resp)
	if resp.Staged != 0 || len(resp.Results) != 1 || resp.Results[0].Error == "" {
		t.Fatalf("expected the reset to be refused, got %+v", resp)
	}
}

// The single-parameter shape every existing caller sends keeps working: one
// paramId at the top, edits that name only an instance and a value.
func TestBatchKeepsTheSingleParameterShape(t *testing.T) {
	root := mixedScopeRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	var resp batchResponse
	doJSON(t, h, http.MethodPut, "/api/values/bulk", map[string]any{
		"paramId": "p-port",
		"edits": []map[string]any{
			{"instance": "east", "value": 9090},
			{"instance": "west", "value": 9091},
		},
	}, &resp)
	if resp.Staged != 2 {
		t.Fatalf("staged = %d, want 2; results %+v", resp.Staged, resp.Results)
	}
	for _, r := range resp.Results {
		if r.ParamID != "p-port" {
			t.Errorf("a result should name the parameter it acted on, got %q", r.ParamID)
		}
	}
}
