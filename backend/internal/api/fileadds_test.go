package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A direct file edit that ADDS settings used to vanish into "edited directly":
// the new values were in the staged bytes, absent from the grid, and unnamed in
// the review. They are now staged as parameters the change starts managing, so
// they appear where settings appear.
func TestFileEditStagesNewParametersItFound(t *testing.T) {
	root := minimalRepo(t) // instances/staging/values.yaml: app.port 8080, bound as p1
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	var res struct {
		Kind          string `json:"kind"`
		NewParameters int    `json:"newParameters"`
	}
	doJSON(t, h, http.MethodPut, "/api/files/draft", map[string]any{
		"instance": "staging",
		"path":     "instances/staging/values.yaml",
		"content":  "app:\n  port: 8080\n  host: edge-1\nlogging:\n  level: debug\n",
	}, &res)
	if res.Kind != "file" {
		t.Fatalf("kind = %q, want file (unmanaged content changed)", res.Kind)
	}
	if res.NewParameters != 2 {
		t.Fatalf("newParameters = %d, want 2 (app.host and logging.level)", res.NewParameters)
	}

	// The grid shows them as pending additions, with the value the edit put in
	// the file - which is not on disk yet.
	var g struct {
		Rows []struct {
			Param struct {
				ID       string `json:"id"`
				Name     string `json:"name"`
				Scope    string `json:"scope"`
				Bindings []struct {
					File string `json:"file"`
					Path string `json:"path"`
				} `json:"bindings"`
			} `json:"param"`
			Cells map[string]struct {
				Value   any  `json:"value"`
				Set     bool `json:"set"`
				Pending bool `json:"pending"`
			} `json:"cells"`
			PendingAdd bool `json:"pendingAdd"`
		} `json:"rows"`
	}
	doJSON(t, h, http.MethodGet, "/api/grid", nil, &g)
	found := map[string]bool{}
	for _, row := range g.Rows {
		if !row.PendingAdd {
			continue
		}
		found[row.Param.Name] = true
		cell := row.Cells["staging"]
		if !cell.Pending || !cell.Set {
			t.Errorf("%s cell = %+v, want a pending, set cell", row.Param.Name, cell)
		}
		if row.Param.Scope != "instance" {
			t.Errorf("%s scope = %q, want instance (the file is inside the instance folder)", row.Param.Name, row.Param.Scope)
		}
		if len(row.Param.Bindings) != 1 || row.Param.Bindings[0].File != "{folder}/values.yaml" {
			t.Errorf("%s bindings = %+v, want one templated binding", row.Param.Name, row.Param.Bindings)
		}
	}
	if !found["app.host"] || !found["logging.level"] {
		t.Fatalf("pending additions = %v, want app.host and logging.level", found)
	}

	// Saving again with those lines removed withdraws the proposals rather than
	// leaving parameters bound to keys the file no longer has.
	doJSON(t, h, http.MethodPut, "/api/files/draft", map[string]any{
		"instance": "staging",
		"path":     "instances/staging/values.yaml",
		"content":  "app:\n  port: 8080\n  host: edge-1\n",
	}, &res)
	if res.NewParameters != 1 {
		t.Fatalf("after removing logging.level, newParameters = %d, want 1", res.NewParameters)
	}
}

// An edit that only touches values the catalog already manages stays a value
// edit: nothing is "new", so nothing is proposed.
func TestFileEditOfManagedValueProposesNothing(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	var res struct {
		Kind          string `json:"kind"`
		Staged        int    `json:"staged"`
		NewParameters int    `json:"newParameters"`
	}
	doJSON(t, h, http.MethodPut, "/api/files/draft", map[string]any{
		"instance": "staging",
		"path":     "instances/staging/values.yaml",
		"content":  "app:\n  port: 9090\n",
	}, &res)
	if res.Kind != "values" || res.Staged != 1 || res.NewParameters != 0 {
		t.Fatalf("res = %+v, want one value item and no proposals", res)
	}
}

// Undoing the file edit takes the parameters it proposed with it: they exist
// only because those lines do.
func TestUndoingAFileEditWithdrawsItsParameters(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	doJSON(t, h, http.MethodPut, "/api/files/draft", map[string]any{
		"instance": "staging",
		"path":     "instances/staging/values.yaml",
		"content":  "app:\n  port: 8080\n  host: edge-1\n",
	}, nil)
	doJSON(t, h, http.MethodDelete,
		"/api/values?paramId=file:instances/staging/values.yaml&instance=staging", nil, nil)

	if d := s.Store.CurrentDraft(""); d != nil && len(d.Items) != 0 {
		t.Fatalf("draft still holds %+v after undoing the file edit", d.Items)
	}
}

// A file that no longer parses is refused outright - nothing staged - and the
// refusal says WHERE, because "the file does not parse" alone sends the reader
// hunting through the whole file.
func TestFileEditRefusesABrokenFileAndSaysWhere(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	rec := doRaw(t, h, http.MethodPut, "/api/files/draft", map[string]any{
		"instance": "staging",
		"path":     "instances/staging/values.yaml",
		"content":  "app:\n  port: 8080\n   name: demo\n",
	})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
	var e struct {
		Error  string `json:"error"`
		Syntax struct {
			File    string `json:"file"`
			Line    int    `json:"line"`
			Snippet string `json:"snippet"`
		} `json:"syntax"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
		t.Fatal(err)
	}
	if e.Syntax.Line != 3 {
		t.Errorf("syntax.line = %d, want 3 (%s)", e.Syntax.Line, rec.Body.String())
	}
	if e.Syntax.File != "instances/staging/values.yaml" || e.Syntax.Snippet != "name: demo" {
		t.Errorf("syntax = %+v", e.Syntax)
	}
	if !strings.Contains(e.Error, "nothing was staged") {
		t.Errorf("message does not say the edit was refused: %q", e.Error)
	}
	if d := s.Store.CurrentDraft(""); d != nil && len(d.Items) > 0 {
		t.Errorf("a broken file was staged anyway: %+v", d.Items)
	}
}

// A file that is not one of the formats we parse is not "invalid YAML": it was
// never YAML. A README saves like any other file.
func TestFileEditDoesNotSyntaxCheckProse(t *testing.T) {
	root := minimalRepo(t)
	if err := os.WriteFile(filepath.Join(root, "instances", "staging", "README.md"),
		[]byte("# Staging\n\nNote: this is prose.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	doJSON(t, s.Routes(), http.MethodPut, "/api/files/draft", map[string]any{
		"instance": "staging",
		"path":     "instances/staging/README.md",
		"content":  "# Staging\n\nNote: this is prose, and: it has colons.\n",
	}, nil)
}

// Duplicating a list entry stages the copy as an ordinary file edit plus the
// parameters it brought with it - the same road a hand edit travels.
func TestDuplicateEntryStagesTheCopyAndItsParameters(t *testing.T) {
	root := minimalRepo(t)
	if err := os.WriteFile(filepath.Join(root, "instances", "staging", "net.xml"),
		[]byte("<config>\n  <net-info>\n    <label>a</label>\n  </net-info>\n  <net-info>\n    <label>b</label>\n  </net-info>\n</config>\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	var res struct {
		NewPath       string `json:"newPath"`
		NewParameters int    `json:"newParameters"`
	}
	doJSON(t, h, http.MethodPost, "/api/files/duplicate", map[string]any{
		"instance": "staging", "file": "instances/staging/net.xml",
		"path": "/config/net-info[1]",
	}, &res)
	if res.NewPath != "/config/net-info[3]" {
		t.Fatalf("newPath = %q, want net-info[3] (appended, not inserted)", res.NewPath)
	}
	if res.NewParameters != 1 {
		t.Fatalf("newParameters = %d, want 1 (the copy's label)", res.NewParameters)
	}

	// The copy is in the draft's file bytes with the source entry's value, and
	// the entries that were already there did not move.
	var files struct {
		Files []struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		} `json:"files"`
	}
	doJSON(t, h, http.MethodGet, "/api/render/staging", nil, &files)
	var content string
	for _, f := range files.Files {
		if f.Path == "instances/staging/net.xml" {
			content = f.Content
		}
	}
	if strings.Count(content, "<net-info>") != 3 {
		t.Fatalf("expected three entries:\n%s", content)
	}
	if !strings.HasPrefix(content, "<config>\n  <net-info>\n    <label>a</label>") {
		t.Errorf("the entries above the copy were rewritten:\n%s", content)
	}
}
