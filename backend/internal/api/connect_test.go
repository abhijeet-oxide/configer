package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A previous attempt (or a server stopped mid-clone) can leave a working copy
// behind in Configer's own data directory. Git would then refuse the next
// attempt with "already exists and is not an empty directory" - a failure about
// scratch space the user cannot see, on a button they pressed once. The
// leftover is cleared instead.
func TestPrepareCloneDirClearsLeftover(t *testing.T) {
	hub, _ := testHub(t)
	dir := filepath.Join(t.TempDir(), "repos", "leftover")
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := hub.prepareCloneDir(dir); err != nil {
		t.Fatalf("prepareCloneDir: %v", err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("a leftover working copy should be cleared before cloning")
	}
}

// A directory a CONNECTED application still uses is never removed: that would
// destroy the working copy of a healthy application.
func TestPrepareCloneDirKeepsConnected(t *testing.T) {
	hub, _ := testHub(t)
	inUse := hub.registry.List()[0].Path
	err := hub.prepareCloneDir(inUse)
	if err == nil {
		t.Fatal("a directory in use by a connected application must not be cleared")
	}
	if _, serr := os.Stat(inUse); serr != nil {
		t.Error("the connected application's working copy was removed")
	}
	if strings.Contains(err.Error(), "git") {
		t.Errorf("error should read as plain words, got %q", err)
	}
}

// Git's own wording never reaches the user.
func TestFriendlyConnectError(t *testing.T) {
	cases := map[string]string{
		"clone https://x/y: fatal: destination path 'x' already exists and is not an empty directory": "previous copy",
		"clone https://x/y: fatal: Authentication failed for 'https://x/y'":                           "sign in again",
		"clone https://x/y: fatal: Remote branch nope not found in upstream origin":                   "branch",
		"clone https://x/y: fatal: could not resolve host: github.com":                                "could not be reached",
	}
	for in, want := range cases {
		got := friendlyConnectError(errString(in))
		if !strings.Contains(got, want) {
			t.Errorf("friendlyConnectError(%q) = %q, want it to mention %q", in, got, want)
		}
		if strings.Contains(got, "fatal:") {
			t.Errorf("git jargon leaked to the user: %q", got)
		}
	}
}

// An application this deployment does not have is a STATE the UI renders as an
// empty page, so the answer carries a stable code and plain words - not a bare
// "unknown repository: <id>" that every view turns into a red toast.
func TestUnknownApplicationIsAState(t *testing.T) {
	_, handler := testHub(t)
	res := call(t, handler, http.MethodGet, "/api/repos/does-not-exist/grid", "tok-admin", "")
	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", res.Code)
	}
	var body APIError
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Code != CodeUnknownRepository {
		t.Errorf("code = %q, want %q", body.Code, CodeUnknownRepository)
	}
	if strings.Contains(body.Error, "repository") && strings.Contains(body.Error, "does-not-exist") {
		t.Errorf("message should not echo internals: %q", body.Error)
	}
}

type errString string

func (e errString) Error() string { return string(e) }
