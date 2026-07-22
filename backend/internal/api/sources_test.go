package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
)

// addSourceTest defines a source and returns its id (the create endpoint
// answers 201, so it uses the raw helper rather than doJSON's 200 gate).
func addSourceTest(t *testing.T, h http.Handler, body map[string]any) string {
	t.Helper()
	rec := doRaw(t, h, http.MethodPost, "/api/sources", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("add source: status %d, body %s", rec.Code, rec.Body.String())
	}
	var added map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &added); err != nil {
		t.Fatal(err)
	}
	id, _ := added["id"].(string)
	if id == "" {
		t.Fatalf("source id missing: %+v", added)
	}
	return id
}

// The full happy path: define a source, map a parameter to it, and have an
// upstream value that differs surface as an incoming change the reviewer
// accepts into the draft.
func TestSourcesMapIncomingAccept(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	id := addSourceTest(t, h, map[string]any{
		"name": "Defaults", "kind": "git",
		"config": map[string]string{"repoUrl": "https://github.com/acme/x", "branch": "main"},
	})

	var list []map[string]any
	doJSON(t, h, http.MethodGet, "/api/sources", nil, &list)
	if len(list) != 1 {
		t.Fatalf("want 1 source, got %d", len(list))
	}

	// Map p1 (integer, staging value 8080) to a source key.
	doJSON(t, h, http.MethodPost, "/api/parameters/p1/source",
		map[string]any{"sourceId": id, "key": "$.app.port"}, &map[string]any{})

	// Seed the cache with a DIFFERENT upstream value so a change is detected.
	s.cacheSnapshot(id, []plugin.SourceKV{{Key: "$.app.port", Value: 9090, Type: model.TypeInteger}})

	var inc struct {
		Changes []IncomingChange `json:"changes"`
	}
	doJSON(t, h, http.MethodGet, "/api/sources/incoming", nil, &inc)
	if len(inc.Changes) != 1 || inc.Changes[0].ParamID != "p1" || inc.Changes[0].Instance != "staging" {
		t.Fatalf("unexpected incoming changes: %+v", inc.Changes)
	}

	var acc struct {
		Staged  int `json:"staged"`
		Pending int `json:"pending"`
	}
	doJSON(t, h, http.MethodPost, "/api/sources/incoming/accept",
		map[string]any{"changes": []map[string]string{{"paramId": "p1", "instance": "staging"}}}, &acc)
	if acc.Staged != 1 {
		t.Fatalf("want 1 staged, got %d", acc.Staged)
	}

	draft := s.Store.CurrentDraft(singleUserAuthor)
	if draft == nil || len(draft.Items) != 1 {
		t.Fatalf("draft item was not staged: %+v", draft)
	}
	if stringify(draft.Items[0].New) != "9090" {
		t.Fatalf("staged value = %v, want 9090", draft.Items[0].New)
	}
}

// A secret source's incoming value is its reference, never plaintext, and that
// reference is what gets staged for write-back.
func TestSourcesSecretStagesReference(t *testing.T) {
	root := minimalRepo(t)
	s, _ := New(root)
	h := s.Routes()

	id := addSourceTest(t, h, map[string]any{
		"name": "Prod Vault", "kind": "vault", "secret": true,
		"config": map[string]string{"address": "https://vault", "mount": "secret", "path": "telco/prod"},
	})

	doJSON(t, h, http.MethodPost, "/api/parameters/p1/source",
		map[string]any{"sourceId": id, "key": "db_password"}, &map[string]any{})

	ref := "${vault:secret/telco/prod#db_password}"
	s.cacheSnapshot(id, []plugin.SourceKV{{Key: "db_password", Value: "********", Secret: true, Ref: ref}})

	var inc struct {
		Changes []IncomingChange `json:"changes"`
	}
	doJSON(t, h, http.MethodGet, "/api/sources/incoming", nil, &inc)
	if len(inc.Changes) == 0 {
		t.Fatal("expected an incoming secret change")
	}
	if inc.Changes[0].Incoming != ref || !inc.Changes[0].Secret {
		t.Fatalf("secret change did not carry the reference: %+v", inc.Changes[0])
	}

	doJSON(t, h, http.MethodPost, "/api/sources/incoming/accept",
		map[string]any{"changes": []map[string]string{{"paramId": "p1", "instance": "staging"}}}, &struct{}{})

	draft := s.Store.CurrentDraft(singleUserAuthor)
	if draft == nil || len(draft.Items) != 1 || draft.Items[0].New != ref {
		t.Fatalf("reference was not staged as-is: %+v", draft)
	}
}

// An unknown source kind is a clean 400, not a crash.
func TestAddSourceRejectsUnknownKind(t *testing.T) {
	root := minimalRepo(t)
	s, _ := New(root)
	h := s.Routes()
	rec := doRaw(t, h, http.MethodPost, "/api/sources", map[string]any{"name": "x", "kind": "nope", "config": map[string]string{}})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for unknown kind, got %d: %s", rec.Code, rec.Body.String())
	}
}
