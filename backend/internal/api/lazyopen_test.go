package api

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// newHub builds a Hub over an empty workspace.
func newHub(t *testing.T) *Hub {
	t.Helper()
	h, err := NewHub(t.TempDir(), "", 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	return h
}

// newHubWithRepo builds a Hub seeded with one local repository, and waits for
// the background warmer to finish so a test measuring "was anything opened"
// is not racing it.
func newHubWithRepo(t *testing.T, repo string) *Hub {
	t.Helper()
	h, err := NewHub(t.TempDir(), repo, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	if len(h.registry.List()) == 0 {
		t.Fatal("the seed repository was not registered")
	}
	// The warmer runs on its own goroutine. Close it out by taking every
	// application's open lock: the warmer holds one while it works, so
	// acquiring them all means it has moved past them.
	for _, e := range h.registry.List() {
		h.opens.lock(e.ID)()
	}
	// Then undo whatever it opened, so each test starts from "nothing open"
	// and exercises the on-demand path deliberately.
	h.mu.Lock()
	for id, s := range h.servers {
		s.StopSync()
		delete(h.servers, id)
		delete(h.handlers, id)
	}
	h.openErrs = map[string]openFailure{}
	h.errs = map[string]string{}
	h.mu.Unlock()
	return h
}

func defaultAppID(t *testing.T, h *Hub) string {
	t.Helper()
	list := h.registry.List()
	if len(list) == 0 {
		t.Fatal("no application registered")
	}
	return list[0].ID
}

// TestHubStartsWithoutOpeningApplications is the property that makes a pod
// disposable: starting the service must not fetch any repository. Boot used to
// clone every registered application before the process answered anything.
func TestHubStartsWithoutOpeningApplications(t *testing.T) {
	root := twoInstanceRepo(t)
	h := newHubWithRepo(t, root)

	// Nothing is open, and the portfolio says "opening" rather than an error:
	// a repository the server has not needed yet is a state, not a failure.
	if h.opened(defaultAppID(t, h)) {
		t.Fatal("an application was opened during startup")
	}
	sum := h.summarize(h.registry.List()[0])
	if sum.Status != "opening" {
		t.Fatalf("portfolio status = %q, want opening", sum.Status)
	}
	if sum.Error != "" {
		t.Fatalf("a not-yet-opened application reported an error: %q", sum.Error)
	}
}

// Readiness must not wait for repositories. A pod that answers only once every
// clone has finished is un-ready for the whole startup, and a brand new
// deployment - which has no repositories precisely because nobody can reach it
// to add one - could never become ready at all.
func TestReadyDoesNotDependOnApplications(t *testing.T) {
	h := newHubWithRepo(t, twoInstanceRepo(t))
	rec := httptest.NewRecorder()
	h.ready(rec, httptest.NewRequest(http.MethodGet, "/api/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("readyz = %d before anything was opened, want 200", rec.Code)
	}

	empty := newHub(t)
	rec = httptest.NewRecorder()
	empty.ready(rec, httptest.NewRequest(http.MethodGet, "/api/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("readyz = %d on a deployment with no applications, want 200", rec.Code)
	}
}

// The first request for an application opens it, and only it.
func TestRequestOpensItsOwnApplication(t *testing.T) {
	h := newHubWithRepo(t, twoInstanceRepo(t))
	id := defaultAppID(t, h)

	if !h.ensureOpen(id) {
		t.Fatal("the application did not open on demand")
	}
	if !h.opened(id) {
		t.Fatal("the application is not serving after being opened")
	}
	if sum := h.summarize(h.registry.List()[0]); sum.Status != "" {
		t.Fatalf("an opened application still reports status %q", sum.Status)
	}
}

// Two requests arriving together for an application nobody has opened must
// produce ONE open, not two racing into the same directory.
func TestConcurrentRequestsOpenOnce(t *testing.T) {
	h := newHubWithRepo(t, twoInstanceRepo(t))
	id := defaultAppID(t, h)

	var wg sync.WaitGroup
	results := make([]bool, 8)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = h.ensureOpen(id)
		}(i)
	}
	wg.Wait()
	for i, ok := range results {
		if !ok {
			t.Fatalf("caller %d did not get a serving application", i)
		}
	}
	// One Server object means one open happened; the rest joined it.
	h.mu.Lock()
	n := len(h.servers)
	h.mu.Unlock()
	if n != 1 {
		t.Fatalf("%d servers were built for one application", n)
	}
}

// A failed open is remembered for a while, so an unreachable origin costs one
// timeout occasionally rather than one on every request.
func TestFailedOpenIsRememberedNotRetriedEveryTime(t *testing.T) {
	h := newHub(t)
	// A registry entry pointing at nothing: opening it cannot succeed.
	h.mu.Lock()
	h.openErrs["ghost"] = openFailure{reason: "origin unreachable", at: time.Now()}
	h.mu.Unlock()

	if got := h.openState("ghost"); got != "origin unreachable" {
		t.Fatalf("openState = %q, want the recorded reason", got)
	}
	// ensureOpen on an id the registry does not know must not invent one.
	if h.ensureOpen("ghost") {
		t.Fatal("an unknown application reported itself as serving")
	}
}

// keyedLocks hands out one lock per key: different keys never wait on each
// other, the same key serializes.
func TestKeyedLocksAreIndependentPerKey(t *testing.T) {
	var l keyedLocks
	releaseA := l.lock("a")

	done := make(chan struct{})
	go func() { l.lock("b")(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("a second key blocked on the first key's lock")
	}

	held := make(chan struct{})
	go func() { l.lock("a")(); close(held) }()
	select {
	case <-held:
		t.Fatal("the same key was handed out twice at once")
	case <-time.After(50 * time.Millisecond):
	}
	releaseA()
	select {
	case <-held:
	case <-time.After(2 * time.Second):
		t.Fatal("releasing the lock did not let the waiter through")
	}
}
