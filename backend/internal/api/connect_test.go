package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	if err := hub.prepareCloneDir("acme/x", dir); err != nil {
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
	err := hub.prepareCloneDir("acme/x", inUse)
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

// What reaches the user names their repository, says what to do, and never
// mentions git or Configer's own storage. A folder on the server is not
// something they can see, cause or clear, so a message about one can only ever
// be an admission that something broke on this side.
func TestFriendlyConnectError(t *testing.T) {
	const repo = "https://github.com/acme/ran-config"
	cases := map[string]string{
		"clone x: fatal: destination path 'x' already exists and is not an empty directory":            "fault on the Configer side",
		"clone x: fatal: Authentication failed for 'https://x/y'":                                      "private repository",
		"clone x: fatal: could not read Password for 'https://github.com': terminal prompts disabled":  "private repository",
		"clone x: fatal: Remote branch nope not found in upstream origin":                              "branch",
		"clone x: fatal: could not resolve host: github.com":                                           "could not reach",
		"clone x: remote: Repository not found":                                                        "could not be found",
		// A company proxy or an inspected connection: Configer's own calls to
		// GitHub follow the machine's proxy settings and Git does not, so the
		// repository picker works while the copy fails. Saying only "could not
		// be connected" leaves the user staring at a list that just worked.
		"clone x: fatal: unable to access 'https://github.com/a/b': SSL certificate problem: unable to get local issuer certificate": "proxy",
		"clone x: fatal: unable to access 'https://github.com/a/b': The requested URL returned error: 407":                           "proxy",
		"clone x: fatal: unable to access 'https://github.com/a/b': Failed to connect to github.com port 443":                        "could not reach",
		"clone x: exec: \"git\": executable file not found in $PATH":                                                                "Git is not installed",
	}
	for in, want := range cases {
		got := friendlyConnectError(repo, stageCopy, errString(in))
		if !strings.Contains(got, want) {
			t.Errorf("friendlyConnectError(%q) = %q, want it to mention %q", in, got, want)
		}
		if !strings.Contains(got, repo) {
			t.Errorf("the message should name the repository: %q", got)
		}
		for _, jargon := range []string{"fatal:", "clone", "directory", "folder"} {
			if strings.Contains(strings.ToLower(got), jargon) {
				t.Errorf("%q leaked to the user: %q", jargon, got)
			}
		}
	}
	// "Please try again, it has been cleared" is advice, and advice that does
	// not work is worse than none: a collision on Configer's side is not the
	// user's to retry away, and nothing of theirs was cleared.
	got := friendlyConnectError(repo, stageCopy, errString("fatal: destination path 'x' already exists and is not an empty directory"))
	if strings.Contains(got, "has been cleared") {
		t.Errorf("the message should not claim the user's attempt left something behind: %q", got)
	}
}

// A failure nobody anticipated must still be worth reading. Pointing at a log
// the user often cannot open costs them a round trip to learn anything at all,
// so the last line says which half of the job broke and quotes the one line git
// gave - marked as the underlying report, not as advice.
func TestUnrecognizedFailuresSayWhichHalfBrokeAndWhy(t *testing.T) {
	const repo = "https://github.com/acme/ran-config"
	raw := errString("clone https://x/y: git clone https://x/y /data/repos/.incoming-y-1: exit status 128: " +
		"Cloning into '/data/repos/.incoming-y-1'...\nfatal: the remote end hung up unexpectedly")

	copyErr := friendlyConnectError(repo, stageCopy, raw)
	if !strings.Contains(copyErr, "the remote end hung up unexpectedly") {
		t.Errorf("the reason git gave should survive: %q", copyErr)
	}
	for _, noise := range []string{"exit status", "Cloning into", "fatal:", ".incoming-"} {
		if strings.Contains(copyErr, noise) {
			t.Errorf("%q should not reach the user: %q", noise, copyErr)
		}
	}
	readErr := friendlyConnectError(repo, stageRead, raw)
	if copyErr == readErr {
		t.Error("copying and reading must not produce the same sentence")
	}
	if !strings.Contains(readErr, "could not read it") {
		t.Errorf("a read failure should say so: %q", readErr)
	}
}

// The quoted reason never carries a credential, whatever git echoed back.
func TestQuotedReasonHasNoCredential(t *testing.T) {
	got := gitReason("git clone: exit status 128: fatal: could not read Password for " +
		"'https://x-access-token:ghp_supersecret@github.com': terminal prompts disabled")
	if strings.Contains(got, "ghp_supersecret") {
		t.Fatalf("a credential leaked into the message: %q", got)
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

// The bug this pins down: give up on a slow repository, try again, and the
// second attempt got the SAME id - which is the same folder on the server. The
// first attempt's git clone was still writing there, the two fought over it,
// and the loser reported "a previous copy was still on the server" on every
// attempt from then on. An id is not free until its worker has finished.
func TestConnectDoesNotReuseAFolderAWorkerIsStillUsing(t *testing.T) {
	hub, handler := testHub(t)
	const url = "https://example.invalid/acme/ran-config.git"
	// The attempts below really do start background workers; let them finish so
	// the test does not tear its own data directory down underneath one.
	defer waitForConnects(t, hub)

	// A clone that is still under way owns "ran-config". Its `connecting` row is
	// already gone: the user dismissed the wait, which stops the waiting, not
	// the git process.
	hub.mu.Lock()
	hub.cloning["ran-config"] = true
	hub.mu.Unlock()

	id := connectOnce(t, handler, url, "RAN config")
	if id == "ran-config" {
		t.Fatal("the new attempt claimed the folder a running clone is still using")
	}

	// Once that worker is done the name is free again, so ids stay readable
	// instead of growing a suffix for every attempt ever made.
	hub.mu.Lock()
	delete(hub.cloning, "ran-config")
	for cid := range hub.connecting {
		delete(hub.connecting, cid)
	}
	for cid := range hub.cloning {
		delete(hub.cloning, cid)
	}
	hub.mu.Unlock()
	if again := connectOnce(t, handler, url, "RAN config"); again != "ran-config" {
		t.Errorf("id = %q, want %q back once nothing is using it", again, "ran-config")
	}
}

// Dismissing a connection that is still copying must not delete the folder out
// from under the running clone - that is what turned one slow repository into a
// failure on every attempt after it. The worker clears up after itself instead.
func TestDismissingALiveConnectionLeavesItsFolderToTheWorker(t *testing.T) {
	hub, handler := testHub(t)
	const id = "slow-repo"
	dir := filepath.Join(hub.dataDir, "repos", id)
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	hub.mu.Lock()
	hub.connecting[id] = &connecting{ID: id, Name: "Slow repo", Status: "connecting"}
	hub.cloning[id] = true // a clone is under way
	hub.mu.Unlock()

	if res := call(t, handler, http.MethodDelete, "/api/repos/"+id, "tok-admin", ""); res.Code != http.StatusOK {
		t.Fatalf("dismiss = %d, want 200", res.Code)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Error("the folder was removed while a clone was still writing to it")
	}
	// The worker, finding itself dismissed, is the one that discards the copy.
	if !hub.dismissed(id) {
		t.Error("the worker should see that the connection was dismissed")
	}
}

// connectOnce starts a connection and returns the id the server chose. The
// clone itself fails in the background (the host does not exist); this is about
// which folder the attempt claims, not about the copy succeeding.
func connectOnce(t *testing.T, h http.Handler, url, name string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"url": url, "name": name})
	res := call(t, h, http.MethodPost, "/api/repos", "tok-admin", string(body))
	if res.Code != http.StatusAccepted {
		t.Fatalf("connect = %d: %s", res.Code, res.Body.String())
	}
	var out RepoSummary
	if err := json.Unmarshal(res.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.ID
}

// waitForConnects blocks until no connect worker is still running.
func waitForConnects(t *testing.T, hub *Hub) {
	t.Helper()
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); {
		hub.mu.Lock()
		n := len(hub.cloning)
		hub.mu.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Error("a connect worker never finished")
}

// The failure class this removes: anything already sitting where the working
// copy goes used to make git refuse the clone outright ("destination path
// already exists"), and the user was told about a folder on the server they can
// neither see nor clear. Each attempt now copies into a folder of its own, so a
// leftover is cleared at the end - after the copy succeeded - and never gets a
// vote on whether the repository can be added.
func TestALeftoverWorkingCopyDoesNotStopAConnection(t *testing.T) {
	hub, handler := testHub(t)
	defer waitForConnects(t, hub)
	source := hub.registry.List()[0].Path // a real git repository to copy from

	leftover := filepath.Join(hub.dataDir, "repos", "copy-of-t")
	if err := os.MkdirAll(filepath.Join(leftover, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(leftover, "junk.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	id := connectOnce(t, handler, "file://"+source, "copy of t")
	if id != "copy-of-t" {
		t.Fatalf("id = %q, want the leftover's own name back", id)
	}
	waitForConnects(t, hub)

	if _, ok := hub.registry.Get(id); !ok {
		hub.mu.Lock()
		c := hub.connecting[id]
		hub.mu.Unlock()
		msg := ""
		if c != nil {
			msg = c.Error
		}
		t.Fatalf("the repository was not connected: %s", msg)
	}
	if _, err := os.Stat(filepath.Join(leftover, "junk.txt")); err == nil {
		t.Error("the leftover should have been replaced by the fresh copy")
	}
	if _, err := os.Stat(filepath.Join(leftover, ".git")); err != nil {
		t.Error("the connected application has no working copy")
	}
}

// A server stopped mid-copy leaves an unfinished folder behind. Nobody should
// have to know that to add a repository, so it is cleared at startup.
func TestUnfinishedCopiesAreSweptAtStartup(t *testing.T) {
	dataDir := t.TempDir()
	junk := filepath.Join(dataDir, "repos", incomingPrefix+"flux-cd-123")
	keep := filepath.Join(dataDir, "repos", "flux-cd")
	for _, d := range []string{junk, keep} {
		if err := os.MkdirAll(filepath.Join(d, ".git"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	sweepIncoming(dataDir)
	if _, err := os.Stat(junk); !os.IsNotExist(err) {
		t.Error("an unfinished copy should be cleared at startup")
	}
	if _, err := os.Stat(keep); err != nil {
		t.Error("a real application's working copy must be left alone")
	}
}

// The one refusal at this step that is NOT Configer's own fault names the
// application in the way and what to do, rather than describing storage.
func TestPlacementRefusalNamesTheApplicationInTheWay(t *testing.T) {
	hub, _ := testHub(t)
	inUse := hub.registry.List()[0]
	err := hub.placeClone("acme/flux-cd", t.TempDir(), inUse.Path)
	if err == nil {
		t.Fatal("a connected application's working copy must not be overwritten")
	}
	if !strings.Contains(err.Error(), inUse.Name) {
		t.Errorf("the message should name the application in the way: %q", err)
	}
	if _, serr := os.Stat(inUse.Path); serr != nil {
		t.Error("the connected application's working copy was removed")
	}
}
