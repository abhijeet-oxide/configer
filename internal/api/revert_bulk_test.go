package api

import (
	"net/http"
	"testing"
)

// Undoing a selection is ONE request. It used to be one DELETE per item through
// a per-owner lock, so undoing eighty of them took long enough that the user
// gave up on the dialog and watched the changes drain away afterwards.
func TestRevertManyInOneRequest(t *testing.T) {
	root := twoInstanceRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	staged := []map[string]any{}
	for _, inst := range []string{"staging", "prod"} {
		for _, v := range []int{9001, 9002} {
			doJSON(t, h, http.MethodPut, "/api/values", map[string]any{
				"instance": inst, "paramId": "p-port", "value": v,
			}, nil)
		}
		staged = append(staged, map[string]any{"paramId": "p-port", "instance": inst})
	}
	var draft struct {
		Draft *struct {
			Items []struct{} `json:"items"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)
	if draft.Draft == nil || len(draft.Draft.Items) != 2 {
		t.Fatalf("expected two staged items, got %+v", draft.Draft)
	}

	var out struct {
		OK      bool `json:"ok"`
		Removed int  `json:"removed"`
		Pending int  `json:"pending"`
	}
	doJSON(t, h, http.MethodDelete, "/api/values/bulk", map[string]any{"items": staged}, &out)
	if !out.OK || out.Removed != 2 || out.Pending != 0 {
		t.Fatalf("bulk revert = %+v, want both removed and nothing pending", out)
	}

	// Nothing staged means no draft left sitting in Changes.
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)
	if draft.Draft != nil {
		t.Errorf("an empty draft survived the bulk undo: %+v", draft.Draft)
	}

	// An item that is not there is not an error: two people undoing the same
	// selection must not turn the second one into a failure.
	doJSON(t, h, http.MethodPut, "/api/values", map[string]any{
		"instance": "staging", "paramId": "p-port", "value": 9100,
	}, nil)
	doJSON(t, h, http.MethodDelete, "/api/values/bulk", map[string]any{
		"items": []map[string]any{
			{"paramId": "p-port", "instance": "staging"},
			{"paramId": "p-port", "instance": "nowhere"},
		},
	}, &out)
	if !out.OK || out.Removed != 1 {
		t.Fatalf("bulk revert with an unknown item = %+v, want the known one removed", out)
	}
}
