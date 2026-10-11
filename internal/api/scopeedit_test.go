package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// groupedRepo is minimalRepo's estate with a site, a zone and an environment on
// each instance, and one parameter bound per-instance - the shape every group
// scope is about.
func groupedRepo(t *testing.T) string {
	t.Helper()
	root := minimalRepo(t)
	write := func(rel, content string) {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(".configer/instances.yaml", `apiVersion: configer.io/v1
kind: InstanceRegistry
instances:
  - { name: staging, folder: instances/staging, environment: staging, site: dallas, zone: central }
  - { name: prod-a,  folder: instances/prod-a,  environment: production, site: dallas, zone: central }
  - { name: prod-b,  folder: instances/prod-b,  environment: production, site: frankfurt, zone: emea }
  - { name: lonely,  folder: instances/lonely,  environment: production }
`)
	write("instances/prod-a/values.yaml", "app:\n  port: 8080\n")
	write("instances/prod-b/values.yaml", "app:\n  port: 8080\n")
	write("instances/lonely/values.yaml", "app:\n  port: 8080\n")
	return root
}

// A site-scoped edit reaches the instances OF THAT SITE and nothing else. This
// is the whole promise of a group scope: one value, said once, landing on
// exactly the systems that share it - and, just as importantly, not landing on
// the ones that do not.
func TestSiteScopedEditReachesOnlyThatSite(t *testing.T) {
	s, err := New(groupedRepo(t))
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	var res struct {
		Staged  int    `json:"staged"`
		Reach   string `json:"reach"`
		Results []struct {
			Instance string `json:"instance"`
			OK       bool   `json:"ok"`
			Error    string `json:"error"`
		} `json:"results"`
	}
	doJSON(t, h, http.MethodPut, "/api/values", map[string]any{
		"paramId": "p1", "scope": "site", "group": "dallas", "value": 9090,
	}, &res)

	if res.Reach != "site dallas" {
		t.Fatalf("reach = %q, want it to name the site the user chose", res.Reach)
	}
	got := map[string]bool{}
	for _, r := range res.Results {
		if r.Error != "" {
			t.Fatalf("%s refused: %s", r.Instance, r.Error)
		}
		got[r.Instance] = true
	}
	// staging and prod-a are at dallas; prod-b is at frankfurt and lonely has no
	// site at all, so neither may be touched.
	for _, name := range []string{"staging", "prod-a"} {
		if !got[name] {
			t.Fatalf("site dallas should reach %s, reached %v", name, got)
		}
	}
	for _, name := range []string{"prod-b", "lonely"} {
		if got[name] {
			t.Fatalf("site dallas must not reach %s, reached %v", name, got)
		}
	}
	if res.Staged != 2 {
		t.Fatalf("staged = %d, want 2 (one per instance at the site)", res.Staged)
	}

	// Each instance gets its OWN item, with its own before and after, so the
	// review reads as what the change does to each system.
	var draft struct {
		Draft struct {
			Items []struct {
				ParamID  string `json:"paramId"`
				Instance string `json:"instance"`
				Old      any    `json:"old"`
				New      any    `json:"new"`
			} `json:"items"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)
	if len(draft.Draft.Items) != 2 {
		t.Fatalf("draft items = %d, want one per reached instance: %+v", len(draft.Draft.Items), draft.Draft.Items)
	}
	for _, it := range draft.Draft.Items {
		if it.Instance == "" {
			t.Fatalf("a fanned-out item must name the instance it writes to: %+v", it)
		}
	}
}

// An instance carrying no value for the grouping field belongs to no group of
// that kind, and a group edit must never sweep it in: "nothing was written in
// that column" is not consent to change the system.
func TestGroupEditRefusesAnUnknownGroup(t *testing.T) {
	s, err := New(groupedRepo(t))
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	rec := doRaw(t, h, http.MethodPut, "/api/values", map[string]any{
		"paramId": "p1", "scope": "site", "group": "nowhere", "value": 9090,
	})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 for a group no instance is in", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "nowhere") {
		t.Fatalf("the refusal should name the group asked for, got %s", rec.Body.String())
	}
}

// "These systems" is not an answer on its own. A group scope that does not say
// WHICH site is refused rather than guessed at - guessing here would write a
// value to an estate the user never named.
func TestGroupEditRequiresAGroup(t *testing.T) {
	s, err := New(groupedRepo(t))
	if err != nil {
		t.Fatal(err)
	}
	rec := doRaw(t, s.Routes(), http.MethodPut, "/api/values", map[string]any{
		"paramId": "p1", "scope": "site", "value": 9090,
	})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 when no group is named", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "which site") {
		t.Fatalf("the refusal should ask which site, got %s", rec.Body.String())
	}
}

// A parameter meant for everyone whose only homes are per-instance files is
// still meant for everyone: the edit fans out rather than being refused because
// of how the repository happens to be laid out.
func TestGlobalEditFansOutWithoutASharedFile(t *testing.T) {
	s, err := New(groupedRepo(t))
	if err != nil {
		t.Fatal(err)
	}
	var res struct {
		Staged int    `json:"staged"`
		Reach  string `json:"reach"`
	}
	doJSON(t, s.Routes(), http.MethodPut, "/api/values", map[string]any{
		"paramId": "p1", "scope": "global", "value": 7070,
	}, &res)
	if res.Reach != "every instance" {
		t.Fatalf("reach = %q, want it to say it applies to everyone", res.Reach)
	}
	if res.Staged != 4 {
		t.Fatalf("staged = %d, want one per instance in the estate", res.Staged)
	}
}

// A parameter's own settings are a CHANGE: nothing reaches the catalog on disk
// until the draft carrying it is submitted and published. It used to commit on
// the spot, which is impossible anywhere the default branch is protected.
func TestUpdateParameterStagesRatherThanCommits(t *testing.T) {
	root := groupedRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	before, err := os.ReadFile(filepath.Join(root, ".configer", "parameters.yaml"))
	if err != nil {
		t.Fatal(err)
	}

	var updated struct {
		Scope       string `json:"scope"`
		Description string `json:"description"`
	}
	doJSON(t, h, http.MethodPut, "/api/parameters/p1", map[string]any{
		"scope": "site", "description": "Which port the app listens on",
	}, &updated)
	// The response describes the parameter as it WILL read, so the form can show
	// what was just typed without waiting for the change to be published.
	if updated.Scope != "site" || updated.Description != "Which port the app listens on" {
		t.Fatalf("response should preview the patched parameter, got %+v", updated)
	}

	after, err := os.ReadFile(filepath.Join(root, ".configer", "parameters.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("the catalog on disk must not move until the change is published")
	}

	var draft struct {
		Draft struct {
			Items []struct {
				ParamID string `json:"paramId"`
				Action  string `json:"action"`
				Old     any    `json:"old"`
			} `json:"items"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)
	if len(draft.Draft.Items) != 1 {
		t.Fatalf("expected one staged metadata item, got %+v", draft.Draft.Items)
	}
	it := draft.Draft.Items[0]
	if it.Action != "update-parameter" || it.ParamID != "p1" {
		t.Fatalf("item = %+v, want an update-parameter for p1", it)
	}
	// Old carries the NAME, so the review reads as the setting rather than as a
	// slug long after the entry it describes has been rewritten.
	if name, _ := it.Old.(string); name != "app.port" {
		t.Fatalf("old = %v, want the parameter's name for the review to read by", it.Old)
	}

	// The grid previews it, marked: the rules on screen are the ones being
	// proposed, and saying so is what stops them reading as settled.
	var grid struct {
		Rows []struct {
			Param struct {
				ID    string `json:"id"`
				Scope string `json:"scope"`
			} `json:"param"`
			PendingMeta bool `json:"pendingMeta"`
		} `json:"rows"`
	}
	doJSON(t, h, http.MethodGet, "/api/grid", nil, &grid)
	for _, r := range grid.Rows {
		if r.Param.ID != "p1" {
			continue
		}
		if r.Param.Scope != "site" || !r.PendingMeta {
			t.Fatalf("row = %+v, want the staged scope previewed and marked pending", r)
		}
		return
	}
	t.Fatal("p1 is missing from the grid")
}

// Putting the form back the way it was withdraws the staged edit: a patch that
// changes nothing is not a change, and staging it would put a row in somebody's
// review with no difference in it at all.
func TestUpdateParameterWithNoDifferenceWithdrawsTheEdit(t *testing.T) {
	s, err := New(groupedRepo(t))
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	doJSON(t, h, http.MethodPut, "/api/parameters/p1", map[string]any{"scope": "site"}, nil)
	doJSON(t, h, http.MethodPut, "/api/parameters/p1", map[string]any{"scope": "instance"}, nil)

	var draft struct {
		Draft *struct {
			Items []map[string]any `json:"items"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)
	if draft.Draft != nil && len(draft.Draft.Items) != 0 {
		t.Fatalf("the draft should be empty again, got %+v", draft.Draft.Items)
	}
}

// A parameter's metadata edit and its global value edit sit at exactly the same
// address - this parameter, no instance, no file - so they must be able to
// coexist. Keyed on the address alone, renaming a setting silently threw away
// the value somebody had just typed into it.
func TestMetadataAndValueEditsCoexistOnOneParameter(t *testing.T) {
	root := minimalRepo(t) // one instance, one per-instance parameter
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	doJSON(t, h, http.MethodPut, "/api/values", map[string]any{
		"paramId": "p1", "instance": "staging", "value": 9999,
	}, nil)
	doJSON(t, h, http.MethodPut, "/api/parameters/p1", map[string]any{
		"description": "the port",
	}, nil)

	var draft struct {
		Draft struct {
			Items []struct {
				Action   string `json:"action"`
				Instance string `json:"instance"`
			} `json:"items"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)
	if len(draft.Draft.Items) != 2 {
		t.Fatalf("both edits should stand, got %+v", draft.Draft.Items)
	}

	// And undoing ONE of them by action leaves the other alone.
	doJSON(t, h, http.MethodDelete,
		"/api/values?paramId=p1&instance=&action=update-parameter", nil, nil)
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)
	if len(draft.Draft.Items) != 1 || draft.Draft.Items[0].Instance != "staging" {
		t.Fatalf("undoing the metadata edit must leave the value edit, got %+v", draft.Draft.Items)
	}
}
