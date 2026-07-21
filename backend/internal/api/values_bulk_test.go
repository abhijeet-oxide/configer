package api

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// twoInstanceRepo is a committed repo with two per-instance parameters and two
// instances holding different values, so bulk-set and copy-from have something
// real to fan out across.
func twoInstanceRepo(t *testing.T) string {
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
  - id: p-port
    name: app.port
    category: General
    type: integer
    scope: instance
    bindings:
      - { file: "{folder}/values.yaml", path: $.app.port, format: yaml }
  - id: p-name
    name: app.name
    category: General
    type: string
    scope: instance
    bindings:
      - { file: "{folder}/values.yaml", path: $.app.name, format: yaml }
`)
	write(".configer/instances.yaml", "apiVersion: configer.io/v1\nkind: InstanceRegistry\ninstances:\n  - { name: staging, folder: instances/staging }\n  - { name: prod, folder: instances/prod }\n")
	write("instances/staging/values.yaml", "app:\n  port: 8080\n  name: demo\n")
	write("instances/prod/values.yaml", "app:\n  port: 9090\n  name: prod-app\n")
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

func draftItems(t *testing.T, h http.Handler) []struct {
	ParamID  string `json:"paramId"`
	Instance string `json:"instance"`
	New      any    `json:"new"`
} {
	t.Helper()
	var resp struct {
		Draft struct {
			Items []struct {
				ParamID  string `json:"paramId"`
				Instance string `json:"instance"`
				New      any    `json:"new"`
			} `json:"items"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &resp)
	return resp.Draft.Items
}

// Bulk-set stages one parameter across several instances in one request, and a
// no-op target (value already committed) stages nothing.
func TestBulkStageValue(t *testing.T) {
	root := twoInstanceRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	var resp struct {
		Staged  int `json:"staged"`
		Results []struct {
			Instance string `json:"instance"`
			OK       bool   `json:"ok"`
			Error    string `json:"error"`
		} `json:"results"`
	}
	// staging is 8080 (a real change to 7000); prod set to its committed 9090 (no-op).
	doJSON(t, h, http.MethodPut, "/api/values/bulk", map[string]any{
		"paramId": "p-port",
		"edits": []map[string]any{
			{"instance": "staging", "value": 7000},
			{"instance": "prod", "value": 9090},
			{"instance": "ghost", "value": 1},
		},
	}, &resp)

	if resp.Staged != 1 {
		t.Errorf("staged = %d, want 1 (only staging actually changed)", resp.Staged)
	}
	var ghost string
	for _, r := range resp.Results {
		if r.Instance == "ghost" {
			ghost = r.Error
		}
	}
	if ghost == "" {
		t.Errorf("expected an error result for the unknown instance")
	}

	items := draftItems(t, h)
	if len(items) != 1 || items[0].Instance != "staging" || items[0].ParamID != "p-port" {
		t.Fatalf("draft should hold exactly the staging port edit, got %+v", items)
	}
}

// Copy-from seeds one instance from another: every differing per-instance value
// is staged, matching values are skipped.
func TestCopyInstanceValues(t *testing.T) {
	root := twoInstanceRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	var resp struct {
		Staged int `json:"staged"`
	}
	// Copy prod (port 9090, name prod-app) onto staging (port 8080, name demo):
	// both parameters differ, so both stage.
	doJSON(t, h, http.MethodPost, "/api/instances/staging/copy-from", map[string]any{
		"source": "prod",
	}, &resp)
	if resp.Staged != 2 {
		t.Fatalf("staged = %d, want 2 (both params differ)", resp.Staged)
	}

	items := draftItems(t, h)
	got := map[string]any{}
	for _, it := range items {
		if it.Instance != "staging" {
			t.Errorf("copy staged onto the wrong instance: %+v", it)
		}
		got[it.ParamID] = it.New
	}
	if got["p-name"] != "prod-app" {
		t.Errorf("p-name = %v, want prod-app", got["p-name"])
	}
	// integer coercion makes this a float64(9090) or int; compare via stringify.
	if stringify(got["p-port"]) != "9090" {
		t.Errorf("p-port = %v, want 9090", got["p-port"])
	}
}
