package api

import (
	"encoding/json"
	"net/http"
	"testing"
)

// An instance staged in the draft has no registry entry and no folder on disk,
// but Submit scaffolds it BEFORE applying value edits, so editing one of its
// cells is a legitimate edit. It used to be refused with "instance not found",
// which left the grid's whole new column read-only.
func TestStageValueOnPendingInstance(t *testing.T) {
	root := twoInstanceRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	// Stage a new instance cloned from "staging" (which holds app.port 7000).
	var added struct {
		OK     bool `json:"ok"`
		Staged bool `json:"staged"`
	}
	doJSON(t, h, http.MethodPost, "/api/instances", map[string]any{
		"name": "canary", "cloneFrom": "staging", "environment": "lab",
	}, &added)
	if !added.OK {
		t.Fatal("staging the instance failed")
	}

	// Edit a value on it, exactly as a double-click in the grid does.
	var staged struct {
		OK      bool `json:"ok"`
		Value   any  `json:"value"`
		Pending int  `json:"pending"`
	}
	rec := doRaw(t, h, http.MethodPut, "/api/values", map[string]any{
		"instance": "canary", "paramId": "p-port", "value": 8123,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("edit on a pending instance = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &staged); err != nil || !staged.OK {
		t.Fatalf("the edit was not staged: %v %s", err, rec.Body.String())
	}

	// The draft carries both the instance and the value edit, and the edit's
	// baseline is the clone source's value - what scaffolding will put there -
	// not "absent".
	items := draftItems(t, h)
	var found bool
	for _, it := range items {
		if it.ParamID == "p-port" && it.Instance == "canary" {
			found = true
			if got := toFloat(it.New); got != 8123 {
				t.Errorf("staged new value = %v, want 8123", it.New)
			}
		}
	}
	if !found {
		t.Fatalf("no value item for the pending instance; draft = %+v", items)
	}

	// An unknown instance is still refused: the fallback must not swallow typos.
	if rec := doRaw(t, h, http.MethodPut, "/api/values", map[string]any{
		"instance": "nope", "paramId": "p-port", "value": 1,
	}); rec.Code != http.StatusNotFound {
		t.Errorf("edit on an unknown instance = %d, want 404", rec.Code)
	}
}

func toFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	}
	return -1
}
