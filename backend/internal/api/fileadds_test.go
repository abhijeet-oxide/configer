package api

import (
	"net/http"
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
