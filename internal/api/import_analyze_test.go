package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// analyzeImport must parse a pasted blob into candidate parameters that the
// import UI can select and commit, using the file name for format detection.
func TestAnalyzeImportParsesPastedYAML(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	var resp struct {
		File       string `json:"file"`
		Count      int    `json:"count"`
		Candidates []struct {
			Name    string `json:"name"`
			Path    string `json:"path"`
			Value   any    `json:"value"`
			Format  string `json:"format"`
			Managed bool   `json:"managed"`
		} `json:"candidates"`
	}
	doJSON(t, h, http.MethodPost, "/api/import/analyze", map[string]any{
		"file":    "instances/prod/values.yaml",
		"content": "cache:\n  ttlSeconds: 30\n  host: redis.local\n",
	}, &resp)

	if resp.Count == 0 {
		t.Fatalf("expected candidates from pasted YAML, got none")
	}
	byPath := map[string]any{}
	fmtByPath := map[string]string{}
	for _, c := range resp.Candidates {
		byPath[c.Path] = c.Value
		fmtByPath[c.Path] = c.Format
	}
	if _, ok := byPath["$.cache.ttlSeconds"]; !ok {
		t.Errorf("missing ttlSeconds candidate: %+v", resp.Candidates)
	}
	if byPath["$.cache.host"] != "redis.local" {
		t.Errorf("host = %v, want redis.local", byPath["$.cache.host"])
	}
	if fmtByPath["$.cache.host"] != "yaml" {
		t.Errorf("format = %q, want yaml", fmtByPath["$.cache.host"])
	}
}

// Empty content is a clean 400, not a crash.
func TestAnalyzeImportRejectsEmpty(t *testing.T) {
	root := minimalRepo(t)
	s, _ := New(root)
	h := s.Routes()

	req := httptest.NewRequest(http.MethodPost, "/api/import/analyze", strings.NewReader(`{"content":""}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("empty analyze status = %d, want 400", rec.Code)
	}
}
