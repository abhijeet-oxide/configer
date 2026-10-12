package api

import (
	"context"
	"io/fs"
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/internal/plugin"
)

type fakeQueue struct {
	pending []plugin.ReleaseCandidate
	settled map[string][3]string
}

func (q *fakeQueue) Claim(context.Context, string) (plugin.ReleaseCandidate, bool, error) {
	if len(q.pending) == 0 {
		return plugin.ReleaseCandidate{}, false, nil
	}
	rc := q.pending[0]
	q.pending = q.pending[1:]
	return rc, true, nil
}

func (q *fakeQueue) Settle(_ context.Context, id, state, url, detail string) error {
	q.settled[id] = [3]string{state, url, detail}
	return nil
}

type bumpPort struct{}

func (bumpPort) Manifest() plugin.Manifest {
	return plugin.Manifest{ID: "bump", Name: "Bump", Kind: plugin.KindTransformer}
}
func (bumpPort) Accepts(plugin.ReleaseCandidate) bool { return true }
func (bumpPort) Transform(_ context.Context, rc plugin.ReleaseCandidate, repo fs.FS) ([]plugin.FileChange, error) {
	old, err := fs.ReadFile(repo, "instances/staging/values.yaml")
	if err != nil {
		return nil, err
	}
	return []plugin.FileChange{{
		Path:    "instances/staging/values.yaml",
		Content: []byte(strings.Replace(string(old), "8080", "9090", 1)),
	}}, nil
}

// TestReleaseCandidateBecomesAChangeRequest: a release onboarded in Software
// Gateway has to arrive in ArtiAuto as something a person reviews, never as a
// silent commit. With no transformer installed, or no application connected to
// the repository, the request waits and says why, so the release page can.
func TestReleaseCandidateBecomesAChangeRequest(t *testing.T) {
	hub, _, _ := testHub(t)
	var origin, id string
	for _, e := range hub.registry.List() {
		origin, id = e.Origin, e.ID
	}
	q := &fakeQueue{settled: map[string][3]string{}}
	reg := plugin.NewRegistry()
	runner := &candidateRunner{hub: hub, queue: q, plugins: reg, worker: "test"}

	q.pending = []plugin.ReleaseCandidate{
		{ID: "no-app", Product: "volte", Release: "24.3.1", GitURL: "https://git.example.com/contoso/other"},
		{ID: "no-plugin", Product: "volte", Release: "24.3.1", GitURL: origin},
	}
	for range 2 {
		if _, err := runner.once(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if got := q.settled["no-app"]; got[0] != candidateWaiting || !strings.Contains(got[2], "no application") {
		t.Errorf("no connected application: %v", got)
	}
	if got := q.settled["no-plugin"]; got[0] != candidateWaiting || !strings.Contains(got[2], "no transformer") {
		t.Errorf("no transformer: %v", got)
	}

	reg.RegisterTransformer(bumpPort{})
	q.pending = []plugin.ReleaseCandidate{{ID: "rc", Product: "volte", Release: "24.3.1", GitURL: origin + "/", RequestedBy: "alice"}}
	if _, err := runner.once(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := q.settled["rc"]; got[0] != candidateSucceeded || !strings.Contains(got[2], "CR-") {
		t.Fatalf("with a transformer: %v", got)
	}
	srv, _ := hub.server(id)
	list := srv.Store.List()
	if len(list) == 0 || list[len(list)-1].Title != "Release candidate: volte 24.3.1" || list[len(list)-1].Reference != "rc" {
		t.Fatalf("no change request titled for the release candidate: %+v", list)
	}
}
