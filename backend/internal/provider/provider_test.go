package provider

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRollupChecks(t *testing.T) {
	cases := []struct {
		name string
		runs []checkRun
		want string
	}{
		{"none", nil, "none"},
		{"all pass", []checkRun{{"completed", "success"}, {"completed", "skipped"}}, "passing"},
		{"one running", []checkRun{{"completed", "success"}, {"in_progress", ""}}, "pending"},
		{"one failure beats pending", []checkRun{{"in_progress", ""}, {"completed", "failure"}}, "failing"},
		{"cancelled counts as failing", []checkRun{{"completed", "cancelled"}}, "failing"},
	}
	for _, c := range cases {
		if got := rollupChecks(c.runs); got != c.want {
			t.Errorf("%s: rollupChecks = %q, want %q", c.name, got, c.want)
		}
	}
}

// Get must surface merge-readiness and a rolled-up CI status from the two
// GitHub endpoints it reads (the PR and its head commit's check-runs).
func TestGetSurfacesChecksAndMergeable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/pulls/7"):
			_, _ = w.Write([]byte(`{"number":7,"html_url":"https://gh/pr/7","state":"open","merged":false,"mergeable_state":"blocked","head":{"sha":"abc123"}}`))
		case strings.Contains(r.URL.Path, "/commits/abc123/check-runs"):
			_, _ = w.Write([]byte(`{"total_count":2,"check_runs":[{"status":"completed","conclusion":"success"},{"status":"completed","conclusion":"failure"}]}`))
		default:
			http.Error(w, "unexpected "+r.URL.Path, http.StatusNotFound)
		}
	}))
	defer srv.Close()

	g := &GitHub{Owner: "o", Repo: "r", Token: "t", HTTP: srv.Client(), BaseURL: srv.URL}
	pr, err := g.Get(context.Background(), 7)
	if err != nil {
		t.Fatal(err)
	}
	if pr.Number != 7 || pr.State != "open" {
		t.Errorf("basic fields wrong: %+v", pr)
	}
	if pr.Mergeable != "blocked" {
		t.Errorf("Mergeable = %q, want blocked", pr.Mergeable)
	}
	if pr.Checks != "failing" {
		t.Errorf("Checks = %q, want failing (one run failed)", pr.Checks)
	}
	if pr.HeadSHA != "abc123" {
		t.Errorf("HeadSHA = %q", pr.HeadSHA)
	}
}
