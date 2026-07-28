package api

// Connecting a repository: the request that starts it, the background worker
// that fetches and opens it, and the words the user is told when it does not
// work. It lives apart from the rest of the workspace because it is the only
// part that touches the network, the only part that runs off the request path,
// and the only part whose failures a person has to be able to act on.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/auth"
	"github.com/abhijeet-oxide/configer/backend/internal/gitengine"
	"github.com/abhijeet-oxide/configer/backend/internal/store"
	"github.com/abhijeet-oxide/configer/backend/internal/workspace"
)

// connecting is the transient state of a repository being connected in the
// background.
type connecting struct {
	ID      string
	Name    string
	Origin  string
	Local   bool
	Remote  bool
	AddedAt time.Time
	Status  string // "connecting" | "error"
	Error   string
}

// connect starts connecting a repository and returns immediately. Cloning a
// large private repository can take tens of seconds; blocking the HTTP request
// on it times out behind proxies and makes a client retry start a second
// clone. Instead this validates synchronously, then does the clone/open in the
// background and answers 202 Accepted with a "connecting" summary. The client
// polls the portfolio (GET /repos) until the repository leaves "connecting"
// (ready) or shows status "error".
//
// @Summary     Connect a repository
// @Description Start connecting a repository (clone a git URL, manage no-clone when `mode:"remote"`, or open a local directory). Returns 202 with a `status:"connecting"` summary; poll GET /api/repos until it becomes ready or `status:"error"`. Connecting an already-connected or in-flight origin returns 409 with the existing id (idempotent by origin).
// @Tags        Workspace
// @Accept      json
// @Produce     json
// @Param       body body ConnectRequest true "Repository to connect"
// @Success     202 {object} RepoSummary "Connecting; poll the portfolio"
// @Failure     400 {object} APIError "Missing url"
// @Failure     409 {object} APIError "Already connected or connecting"
// @Security    CookieSession
// @Router      /api/repos [post]
func (h *Hub) connect(w http.ResponseWriter, r *http.Request) {
	// Connecting a repository puts it in front of everyone who uses this
	// deployment (and, for a private one, spends the server's credential doing
	// it), so it needs a signed-in caller. Like rename and disconnect, this
	// endpoint sits outside the per-repository dispatch and so never passed
	// through authorize - it accepted anonymous callers outright.
	if !h.requireUser(w, r) {
		return
	}
	var req struct {
		URL    string `json:"url"`
		Name   string `json:"name"`
		Branch string `json:"branch"`
		Token  string `json:"token"`
		// Mode "remote" manages the repository through the Git data API with
		// NO clone (materialized cache only); default clones as before.
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.URL) == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "url (git URL or local path) is required")
		return
	}
	req.URL = strings.TrimSpace(req.URL)

	// Idempotency by origin: the same origin connected twice would give two
	// divergent working trees of one truth. A connection that already exists,
	// or one already in flight, points the user at the existing id instead of
	// starting a duplicate.
	if id, name, ok := h.originInUse(req.URL); ok {
		writeJSON(w, http.StatusConflict, struct {
			APIError
			ID string `json:"id"`
		}{APIError{Error: "this repository is already connected as \"" + name + "\"", Code: CodeConflict, RequestID: reqID(r)}, id})
		return
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = workspace.NameFromURL(req.URL)
	}
	// Reserve an id that no connected application AND no in-flight attempt is
	// using. Both sets matter: the registry describes what exists, `connecting`
	// and `cloning` describe what is being made right now, and either one owns
	// a folder this attempt must not touch.
	h.mu.Lock()
	taken := make(map[string]bool, len(h.connecting)+len(h.cloning))
	for cid := range h.connecting {
		taken[cid] = true
	}
	for cid := range h.cloning {
		taken[cid] = true
	}
	id := h.registry.UniqueID(workspace.Slug(name), taken)
	h.mu.Unlock()

	// Determine the connection shape and resolve credentials synchronously
	// (they need the request); the slow clone/open happens in the background.
	st, statErr := os.Stat(req.URL)
	isDir := statErr == nil && st.IsDir()
	autoToken := false
	if req.Token == "" && !isDir {
		req.Token, _, _ = h.githubCred(r)
		autoToken = req.Token != ""
	}

	c := &connecting{ID: id, Name: name, Origin: req.URL, Local: isDir,
		Remote: req.Mode == "remote", AddedAt: time.Now().UTC(), Status: "connecting"}
	h.mu.Lock()
	h.connecting[id] = c
	h.cloning[id] = true
	h.mu.Unlock()
	h.auditHub(r, id, "Connecting repository "+name, "POST /repos")

	owner := ""
	if u, ok := auth.UserFrom(r.Context()); ok {
		owner = u.Login
	}
	go h.connectWorker(connectSpec{
		id: id, name: name, url: req.URL, branch: req.Branch, token: req.Token,
		mode: req.Mode, isDir: isDir, autoToken: autoToken, addedAt: c.AddedAt,
		owner: owner,
	})
	writeJSON(w, http.StatusAccepted, connectingSummary(c))
}

// originInUse reports whether an origin is already connected or connecting.
func (h *Hub) originInUse(url string) (id, name string, ok bool) {
	want := gitengine.Redact(url)
	for _, e := range h.registry.List() {
		if gitengine.Redact(e.Origin) == want {
			return e.ID, e.Name, true
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range h.connecting {
		if c.Status == "connecting" && gitengine.Redact(c.Origin) == want {
			return c.ID, c.Name, true
		}
	}
	return "", "", false
}

// connectSpec carries everything the background worker needs (credentials are
// resolved on the request goroutine, before this runs).
type connectSpec struct {
	id, name, url, branch, token, mode string
	isDir, autoToken                   bool
	addedAt                            time.Time
	// owner is the login that asked for this application. Connecting one and
	// then having only view access to it is not a permission model - it is a
	// dead end, and the one every new deployment walked into: the default role
	// is viewer (rightly, for everyone else), so the person who set the
	// application up could not edit it, submit anything, or even see why.
	owner string
}

// connectWorker performs the slow clone/open off the request path, then
// registers the repository or records the failure on the connecting entry.
//
// It owns its folder from the moment the id is reserved until it returns, and
// it releases the reservation on the way out however it ends - so a retry can
// reuse the name only once nothing is still writing there.
func (h *Hub) connectWorker(sp connectSpec) {
	defer func() {
		h.mu.Lock()
		delete(h.cloning, sp.id)
		h.mu.Unlock()
	}()
	// What the repository is called in messages: the address without any
	// credential, which is what the user typed or picked.
	what := gitengine.Redact(sp.url)
	var e workspace.Entry
	switch {
	case sp.isDir:
		abs, _ := filepath.Abs(sp.url)
		e = workspace.Entry{ID: sp.id, Name: sp.name, Origin: abs, Path: abs,
			Branch: sp.branch, Local: true, AddedAt: sp.addedAt}
	case sp.mode == "remote":
		e = workspace.Entry{ID: sp.id, Name: sp.name, Origin: sp.url,
			Path: filepath.Join(h.dataDir, "repos", sp.id), Branch: sp.branch,
			Remote: true, Token: sp.token, AddedAt: sp.addedAt}
	default:
		dir := filepath.Join(h.dataDir, "repos", sp.id)
		// Copy into a folder of this attempt's own, then move it into place.
		// Cloning straight to the final location made anything already sitting
		// there fatal - a leftover from a stopped server, another attempt, the
		// application itself - and git's complaint about it ("destination path
		// already exists") is about Configer's storage, which the user can
		// neither see nor clear. A folder nothing else can name cannot collide.
		staged, cerr := h.cloneToStaging(sp)
		if cerr != nil {
			slog.Warn("clone failed", slog.String("id", sp.id),
				slog.String("origin", what), slog.Any("error", cerr))
			h.failConnecting(sp.id, friendlyConnectError(what, stageCopy, cerr))
			return
		}
		// Removing the staging PARENT takes the copy with it, whether or not
		// the copy has already been moved out of it.
		defer func() { _ = os.RemoveAll(filepath.Dir(staged)) }()
		if h.dismissed(sp.id) {
			return
		}
		// Check what actually arrived, and be exact about whose problem it is.
		// These two look identical from the outside and are opposites: one is a
		// repository with nothing in it yet, the other is Configer failing to
		// copy a repository that is perfectly fine. Reporting the first when it
		// is the second tells the user their work is missing, which is both
		// wrong and alarming.
		if !gitengine.IsRepo(staged) {
			slog.Error("the copy has no repository data in it",
				slog.String("id", sp.id), slog.String("origin", what),
				slog.String("dir", staged), slog.Any("contents", dirNames(staged)))
			h.failConnecting(sp.id, "Configer could not make a usable copy of "+what+". "+internalFaultTail)
			return
		}
		if !gitengine.HasCommits(staged) {
			// A repository created and never pushed to: nothing to read,
			// nothing to branch from, nothing to write back against.
			h.failConnecting(sp.id, what+" has no commits yet, so there is no configuration to manage."+
				" Push at least one file to it, then add it here")
			return
		}
		if perr := h.placeClone(what, staged, dir); perr != nil {
			h.failConnecting(sp.id, perr.Error())
			return
		}
		e = workspace.Entry{ID: sp.id, Name: sp.name, Origin: sp.url, Path: dir,
			Branch: sp.branch, AddedAt: sp.addedAt}
	}

	// The user may have given up on a slow clone while it ran. Their decision
	// stands: clean up what was copied and add nothing, rather than an
	// application appearing minutes later that nobody asked for any more.
	if h.dismissed(sp.id) {
		if !e.Local {
			_ = os.RemoveAll(e.Path)
		}
		slog.Info("connection was dismissed while it ran; discarding the copy",
			slog.String("id", sp.id), slog.String("origin", what))
		return
	}

	if err := h.open(e); err != nil {
		if !e.Local {
			_ = os.RemoveAll(e.Path)
		}
		slog.Warn("could not open the connected repository", slog.String("id", sp.id),
			slog.String("origin", what), slog.Any("error", err))
		h.failConnecting(sp.id, friendlyConnectError(what, stageRead, err))
		return
	}
	if err := h.registry.Add(e); err != nil {
		h.failConnecting(sp.id, friendlyConnectError(what, stageRead, err))
		return
	}
	h.mu.Lock()
	delete(h.connecting, sp.id)
	h.mu.Unlock()
	// Whoever connected it owns it: approver on their own application, so they
	// can edit, review and publish without an administrator having to grant
	// them access to something they just created. Everyone else still starts at
	// the deployment default (viewer), so this grants nothing to anybody else.
	if sp.owner != "" && h.platform != nil && h.auth.Enabled() {
		if err := h.platform.SetMember(context.Background(), store.Member{
			Repo: e.ID, Login: sp.owner, Role: store.RoleApprover,
		}); err != nil {
			slog.Warn("could not record the connecting user as the application's approver",
				slog.String("id", e.ID), slog.String("login", sp.owner), slog.Any("error", err))
		}
	}
	h.enqueueReindex(e.ID)
	slog.Info("workspace connected repository", slog.String("id", e.ID), slog.String("origin", gitengine.Redact(e.Origin)))
}

// incomingPrefix names a folder a connection is still copying into. It starts
// with a dot so it can never be mistaken for an application id, and it is swept
// at startup: a server stopped mid-clone leaves one behind, and nobody should
// have to know that to add a repository.
const incomingPrefix = ".incoming-"

// sweepIncoming removes staging folders left by a server that stopped while a
// clone was running. Anything under this prefix is by definition unfinished.
func sweepIncoming(dataDir string) {
	base := filepath.Join(dataDir, "repos")
	entries, err := os.ReadDir(base)
	if err != nil {
		return
	}
	for _, ent := range entries {
		if !ent.IsDir() || !strings.HasPrefix(ent.Name(), incomingPrefix) {
			continue
		}
		slog.Info("clearing an unfinished copy left by an earlier run", slog.String("dir", ent.Name()))
		_ = os.RemoveAll(filepath.Join(base, ent.Name()))
	}
}

// cloneTimeout caps a single fetch. It is generous - a large repository over a
// slow link is normal - but it is not absent: without it a connection that
// stalls leaves the card saying "Connecting" for as long as the server runs,
// and the id it holds can never be reused. CONFIGER_CLONE_MINUTES tunes it for
// a deployment with genuinely huge repositories.
func cloneTimeout() time.Duration {
	if m, err := strconv.Atoi(strings.TrimSpace(os.Getenv("CONFIGER_CLONE_MINUTES"))); err == nil && m > 0 {
		return time.Duration(m) * time.Minute
	}
	return 30 * time.Minute
}

// cloneToStaging copies the repository into a folder of this attempt's own and
// returns it. The caller moves it into place; on any failure nothing is left
// behind, so no later attempt inherits this one's mess.
func (h *Hub) cloneToStaging(sp connectSpec) (string, error) {
	gitName := getenv("CONFIGER_GIT_NAME", "Configer Bot")
	gitEmail := getenv("CONFIGER_GIT_EMAIL", "configer-bot@localhost")
	base := filepath.Join(h.dataDir, "repos")
	try := func(token string) (string, error) {
		if err := os.MkdirAll(base, 0o755); err != nil {
			return "", err
		}
		// The staging PARENT is what carries the unique name; git is given a
		// path inside it that does not exist yet. That distinction is not
		// cosmetic: cloning a repository with no commits into a folder that
		// already exists leaves git nothing to check out and it writes no .git
		// at all, so what arrives is an empty folder that later code cannot
		// tell from a plain directory. Handing git a path of its own restores
		// the behaviour every other clone in the world gets.
		parent, err := os.MkdirTemp(base, incomingPrefix+sp.id+"-")
		if err != nil {
			return "", err
		}
		tmp := filepath.Join(parent, "repo")
		ctx, cancel := context.WithTimeout(context.Background(), cloneTimeout())
		defer cancel()
		if _, cerr := gitengine.CloneContext(ctx, sp.url, tmp, sp.branch, token, gitName, gitEmail); cerr != nil {
			_ = os.RemoveAll(parent)
			return "", cerr
		}
		return tmp, nil
	}
	staged, err := try(sp.token)
	if err != nil && sp.autoToken {
		// A credential Configer supplied on the user's behalf must never make
		// things worse than having none: try once the way the public would.
		// The first failure is the one worth reporting if this fails too - it
		// is the one about the access the user actually has.
		if anon, aerr := try(""); aerr == nil {
			return anon, nil
		}
	}
	return staged, err
}

// placeClone moves a finished copy to the folder the application will use.
//
// Everything it can refuse for is a fault on this side: the copy succeeded, so
// the repository and the user's access to it are not in question. Each failure
// says which step broke, because one sentence for three causes is a sentence
// nobody can act on - including whoever reads the report.
func (h *Hub) placeClone(what, staged, dir string) error {
	if err := h.prepareCloneDir(what, dir); err != nil {
		return err
	}
	if err := os.Rename(staged, dir); err != nil {
		slog.Error("could not move a finished copy into place",
			slog.String("from", staged), slog.String("to", dir), slog.Any("error", err))
		return errors.New("Configer copied " + what + " but could not put it in place on the server. " + internalFaultTail)
	}
	return nil
}

// internalFaultTail ends every message about a failure on Configer's own side.
// It says whose problem it is and who can see the reason, and asks nothing of
// the user that would not work - "try again" is not advice when the cause is a
// folder they cannot reach.
const internalFaultTail = "This is a fault on the Configer side, not with the repository; the reason is in the service log, so tell an administrator if it happens again."

// prepareCloneDir makes sure the final location is free before a finished copy
// is moved into it.
//
// A server stopped mid-clone (before staging folders existed) can leave one
// behind, and a location no connected application claims is exactly that. One
// that IS claimed is left alone and reported: it holds a healthy application's
// working copy.
func (h *Hub) prepareCloneDir(what, dir string) error {
	if _, err := os.Stat(dir); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		slog.Error("cannot read the working copy location", slog.String("dir", dir), slog.Any("error", err))
		return errors.New("Configer could not read where it keeps " + what + " on the server. " + internalFaultTail)
	}
	for _, e := range h.registry.List() {
		if filepath.Clean(e.Path) == filepath.Clean(dir) {
			slog.Error("working copy location is claimed by a connected application",
				slog.String("dir", dir), slog.String("id", e.ID))
			return errors.New("the application \"" + e.Name + "\" already keeps its copy where " + what +
				" would go. Disconnect it first, or add this one under a different name")
		}
	}
	slog.Info("removing a leftover working copy before putting a new one in place", slog.String("dir", dir))
	if err := os.RemoveAll(dir); err != nil {
		slog.Error("could not clear a leftover working copy", slog.String("dir", dir), slog.Any("error", err))
		return errors.New("Configer could not clear an old copy of " + what + " on the server. " + internalFaultTail)
	}
	return nil
}

// connectStage says how far a connection got, so a failure nobody could
// classify still tells the user (and whoever they report it to) which half of
// the job broke: getting the repository onto the server, or reading it once it
// was there. One sentence for both was the difference between a report that
// can be acted on and a screenshot that only says "it did not work".
type connectStage int

const (
	stageCopy connectStage = iota // fetching the repository
	stageRead                     // opening what was fetched
)

// gitReason reduces a failure to the one line worth repeating: the last thing
// git actually said, without the command Configer ran to say it, without
// "fatal:", and with any credential stripped.
func gitReason(msg string) string {
	// Credentials appear mid-sentence in git's own output, so redact the whole
	// block before anything else looks at it.
	msg = gitengine.RedactAll(strings.ReplaceAll(msg, "\r\n", "\n"))
	best := ""
	for _, line := range strings.Split(msg, "\n") {
		line = strings.TrimSpace(line)
		low := strings.ToLower(line)
		if line == "" || strings.HasPrefix(low, "cloning into") ||
			strings.HasPrefix(low, "warning:") || strings.Contains(low, "exit status") {
			continue
		}
		best = line
	}
	if best == "" {
		// Everything was on one line: drop Configer's own wrapper (the command
		// it ran and the status it got) and keep what git said after it.
		best = strings.TrimSpace(msg)
		if i := strings.LastIndex(best, "exit status"); i >= 0 {
			if j := strings.Index(best[i:], ": "); j >= 0 {
				best = strings.TrimSpace(best[i+j+2:])
			}
		}
	}
	// git labels every line with its own severity; the user is already being
	// told this is a failure.
	for _, noise := range []string{"fatal: ", "error: ", "remote: "} {
		best = strings.TrimPrefix(best, noise)
	}
	best = strings.TrimSuffix(strings.TrimSpace(best), ".")
	if len(best) > 200 {
		best = strings.TrimSpace(best[:200]) + "…"
	}
	return best
}

// friendlyConnectError turns a git failure into something the person who
// pressed the button can act on: what did not work, and what they can do about
// it. The original text goes to the log.
//
// Two rules. Never git jargon - the user asked for a repository, not for a
// clone. And never Configer's own storage: a folder on the server is not
// something they can see, cause or clear, so a message about one is only ever
// an admission that something broke on this side, never an instruction.
//
// The exception is the last line, when nothing else fits. A message that
// explains nothing and points at a log the user often cannot read is worse than
// one technical clause: it costs them a round trip to find out anything at all.
// So an unrecognized failure quotes the one line git gave, plainly marked as
// the underlying report rather than as advice.
//
// `what` names the repository (its address, credential stripped), because
// "the repository could not be found" is a shrug and "acme/ran-config could not
// be found" is an answer.
func friendlyConnectError(what string, stage connectStage, err error) string {
	if what == "" {
		what = "that repository"
	}
	msg := err.Error()
	low := strings.ToLower(msg)
	switch {
	case strings.Contains(low, "already exists and is not an empty directory"),
		strings.Contains(low, "destination path"):
		// Each attempt copies into a folder of its own that nothing else can
		// name, so this cannot happen any more. If it does, something is
		// writing into Configer's storage and the user is not the cause.
		return "Configer could not make a copy of " + what + " on the server. " + internalFaultTail
	case strings.Contains(low, "authentication failed"), strings.Contains(low, "could not read username"),
		// Git asks for a password it cannot ask for (no terminal on a server):
		// the credential Configer had was not accepted, or there was none.
		strings.Contains(low, "could not read password"), strings.Contains(low, "terminal prompts disabled"),
		strings.Contains(low, "invalid username or password"), strings.Contains(low, "401"),
		strings.Contains(low, "403"), strings.Contains(low, "permission denied"):
		return "your GitHub sign-in was not accepted for " + what +
			". If it is a private repository, check that your account can open it on GitHub, then sign out and in again so Configer picks up the change"
	case strings.Contains(low, "remote branch"), strings.Contains(low, "not found in upstream origin"):
		return "that branch does not exist in " + what + "; pick another branch"
	case strings.Contains(low, "executable file not found"), strings.Contains(low, "command not found"),
		strings.Contains(low, "no such file or directory: git"):
		return "Git is not installed on the machine running Configer, so it cannot fetch " + what +
			". An administrator needs to install it"
	case strings.Contains(low, "ssl certificate"), strings.Contains(low, "certificate verif"),
		strings.Contains(low, "self-signed certificate"), strings.Contains(low, "unable to get local issuer"),
		strings.Contains(low, "gnutls"), strings.Contains(low, "schannel"),
		strings.Contains(low, "proxy"), strings.Contains(low, "407"):
		// The picker can list repositories while this fails: Configer's own
		// calls to GitHub follow the machine's proxy settings, and Git does not
		// unless it has been told to. That is worth saying, because "it works in
		// my browser" is exactly what the user is looking at.
		return "the server could not open a secure connection to " + what +
			". Listing repositories can work while this does not: the machine running Configer reaches GitHub through a company proxy or inspected connection that Git has not been told about, and an administrator needs to configure it"
	case strings.Contains(low, "context deadline exceeded"), strings.Contains(low, "context canceled"):
		return "fetching " + what + " took too long and was stopped. A repository this size can need longer" +
			" - an administrator can raise the limit - but a connection that stalls looks the same, so it is worth checking that the machine running Configer can reach GitHub"
	case strings.Contains(low, "failed to connect"), strings.Contains(low, "unable to access"),
		strings.Contains(low, "could not resolve host"), strings.Contains(low, "connection refused"),
		strings.Contains(low, "timed out"), strings.Contains(low, "network is unreachable"),
		strings.Contains(low, "network"):
		return "the machine running Configer could not reach " + what +
			". Check that it has access to that host - if it reaches the internet through a company proxy, an administrator needs to configure Git to use it"
	case strings.Contains(low, "repository not found"), strings.Contains(low, "not found"):
		return what + " could not be found. Check the address, and that your GitHub sign-in can open it" +
			" - a private repository you have no access to looks exactly like one that does not exist"
	case strings.Contains(low, "no space left"):
		return "there is not enough room on the server to copy " + what + "; an administrator needs to free some space"
	}
	// Nothing matched. Say which half of the job broke and quote what git said,
	// so one screenshot is enough to work out the rest.
	head := what + " could not be fetched from GitHub."
	if stage == stageRead {
		head = "Configer fetched " + what + " but could not read it."
	}
	if reason := gitReason(msg); reason != "" {
		return head + " The reason given was: " + reason
	}
	return head + " " + internalFaultTail
}

// dirNames lists what is in a directory, for a log line that has to explain
// why a copy could not be used.
func dirNames(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []string{"unreadable: " + err.Error()}
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.Name())
	}
	if len(out) == 0 {
		return []string{"(empty)"}
	}
	return out
}

// dismissed reports whether the user gave up on this connection while it was
// still running (DELETE /repos/{id} removes the entry the portfolio polls).
func (h *Hub) dismissed(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, still := h.connecting[id]
	return !still
}

// failConnecting records a background connection failure so the portfolio shows
// it (status "error") until the user dismisses it via DELETE /repos/{id}.
func (h *Hub) failConnecting(id, msg string) {
	h.mu.Lock()
	if c, ok := h.connecting[id]; ok {
		c.Status = "error"
		c.Error = msg
	}
	h.mu.Unlock()
	slog.Warn("workspace connect failed", slog.String("id", id), slog.String("error", msg))
}

// connectingSummary renders a transient connecting entry as a portfolio card.
func connectingSummary(c *connecting) RepoSummary {
	return RepoSummary{
		ID: c.ID, Name: c.Name, Origin: gitengine.Redact(c.Origin),
		Local: c.Local, NoClone: c.Remote, AddedAt: c.AddedAt,
		Status: c.Status, Error: c.Error,
	}
}
