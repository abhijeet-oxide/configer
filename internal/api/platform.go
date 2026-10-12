package api

// Platform layer: sign-in through the platform's identity provider, every
// request checked against the platform's policy engine, and the audit trail.
// With no issuer configured the deployment is the single-user tool it always
// was, and the database is an embedded SQLite file.

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/abhijeet-oxide/configer/internal/auth"
	"github.com/abhijeet-oxide/configer/internal/store"
	"github.com/abhijeet-oxide/softwareGateway/pkg/authz"
)

// newPlatform opens the platform store and the sign-in service from the
// environment. DATABASE_URL selects PostgreSQL (the shared platform database);
// CONFIGER_AUTH_ISSUER turns sign-in on.
func newPlatform(dataDir string) (*store.Store, *auth.Service, error) {
	st, err := store.Open(dataDir, os.Getenv("DATABASE_URL"))
	if err != nil {
		return nil, nil, err
	}
	svc, err := newAuth(st)
	if err != nil {
		_ = st.Close()
		return nil, nil, err
	}
	return st, svc, nil
}

// newAuth builds the verifier and the policy engine. A deployment that asked
// for sign-in and cannot have it refuses to start: running anyway would mean
// running in single-user mode, where everybody may do everything.
func newAuth(st *store.Store) (*auth.Service, error) {
	issuer := strings.TrimSpace(os.Getenv("CONFIGER_AUTH_ISSUER"))
	svc := &auth.Service{Store: st, AdminRole: getenv("CONFIGER_ADMIN_ROLE", "org-admin")}
	if issuer == "" {
		return svc, nil
	}
	tenant := strings.TrimSpace(os.Getenv("CONFIGER_AUTH_TENANT"))
	if tenant == "" {
		return nil, fmt.Errorf("CONFIGER_AUTH_ISSUER is set but CONFIGER_AUTH_TENANT is empty: refusing to start with no tenant boundary")
	}
	cerbos := strings.TrimSpace(os.Getenv("CONFIGER_CERBOS_ADDR"))
	if cerbos == "" {
		return nil, fmt.Errorf("CONFIGER_AUTH_ISSUER is set but CONFIGER_CERBOS_ADDR is empty: every action needs the policy engine")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	v, err := authz.NewVerifier(ctx, authz.Config{
		Issuer:           issuer,
		DiscoveryURL:     os.Getenv("CONFIGER_AUTH_DISCOVERYURL"),
		HostHeader:       os.Getenv("CONFIGER_AUTH_HOSTHEADER"),
		Audience:         os.Getenv("CONFIGER_AUTH_AUDIENCE"),
		AudiencesFile:    os.Getenv("CONFIGER_AUTH_AUDIENCESFILE"),
		JWKSCachePath:    getenv("CONFIGER_AUTH_JWKSCACHEPATH", "/tmp/artiauto-jwks.json"),
		WorkloadJWKSFile: os.Getenv("CONFIGER_AUTH_WORKLOADJWKSFILE"),
		RequireAudience:  true,
		Tenant:           tenant,
	})
	if err != nil {
		return nil, fmt.Errorf("sign-in is configured but not usable: %w", err)
	}
	engine := authz.NewCerbos(cerbos)
	engine.Tenant = tenant
	svc.Verifier = v
	svc.Engine = engine
	return svc, nil
}

// authorize checks one application request against the policy engine. It
// answers 401 when nobody is signed in and 403, in words, when the action is
// not theirs to take.
func (h *Hub) authorize(w http.ResponseWriter, r *http.Request, repoID string) bool {
	if !h.auth.Enabled() {
		return true
	}
	if _, ok := auth.UserFrom(r.Context()); !ok {
		writeError(w, r, http.StatusUnauthorized, CodeUnauthorized, "sign in to use this deployment")
		return false
	}
	rest := r.URL.Path
	if p := strings.TrimPrefix(rest, "/api/repos/"+repoID); p != rest {
		rest = p
	} else {
		rest = strings.TrimPrefix(rest, "/api")
	}
	return h.allow(w, r, h.applicationResource(repoID), actionFor(r.Method, rest))
}

// allow puts one action to the policy engine and writes the refusal when the
// answer is no.
func (h *Hub) allow(w http.ResponseWriter, r *http.Request, res authz.Resource, action string) bool {
	got, err := h.auth.Allowed(r.Context(), res, action)
	if err != nil {
		h.log().Error("permission check failed", "action", action, "kind", res.Kind, "error", err)
		writeError(w, r, http.StatusServiceUnavailable, CodeUnavailable,
			"permissions cannot be checked right now; try again in a moment")
		return false
	}
	if !got[action] {
		writeError(w, r, http.StatusForbidden, CodeForbidden,
			"you do not have permission to "+actionPhrase[action])
		return false
	}
	return true
}

// audit records a state-changing request outcome, best effort. The action is
// a plain-language description of what happened (humanizeAction), and the raw
// "METHOD /path" is kept in detail for anyone who wants the API truth. The
// actor is the resolved author the handler recorded (never a bare
// "anonymous" when the request carried an author).
func (h *Hub) audit(r *http.Request, repoID string, status int) {
	if h.platform == nil || status >= 400 || r.Method == http.MethodGet ||
		r.Method == http.MethodHead || r.Method == http.MethodOptions {
		return
	}
	login := "anonymous"
	if u, ok := auth.UserFrom(r.Context()); ok {
		login = u.Login
	} else if hld, ok := r.Context().Value(actorKey).(*actorHolder); ok && hld.name != "" {
		login = hld.name
	}
	// Normalize both the scoped (/api/repos/<id>/<rest>) and the unscoped
	// single-user (/api/<rest>) forms down to /<rest> so humanization keys off
	// the resource, not the routing prefix.
	rest := r.URL.Path
	if p := strings.TrimPrefix(rest, "/api/repos/"+repoID); p != rest {
		rest = p
	} else {
		rest = strings.TrimPrefix(rest, "/api")
	}
	_ = h.platform.Audit(r.Context(), store.Event{
		Login:  login,
		Repo:   repoID,
		Action: humanizeAction(r.Method, rest),
		Detail: r.Method + " " + rest,
	})
}

// auditHub records a hub-level mutation (member management, repository
// lifecycle) that does not pass through dispatch, so these security-relevant
// actions land in the trail too. Best effort, like audit.
func (h *Hub) auditHub(r *http.Request, repoID, action, detail string) {
	if h.platform == nil {
		return
	}
	login := "anonymous"
	if u, ok := auth.UserFrom(r.Context()); ok {
		login = u.Login
	}
	_ = h.platform.Audit(r.Context(), store.Event{
		Login: login, Repo: repoID, Action: action, Detail: detail,
	})
}

// humanizeAction turns an HTTP method + path into a plain-language sentence a
// non-engineer can read ("Edited a configuration value"), so the audit trail
// says what happened, not which endpoint was called. The raw method/path
// stays available as the event detail.
func humanizeAction(method, path string) string {
	seg := strings.Split(strings.Trim(path, "/"), "/")
	head := ""
	if len(seg) > 0 {
		head = seg[0]
	}
	arg := ""
	if len(seg) > 1 {
		arg = seg[1]
	}
	tail := ""
	if len(seg) > 2 {
		tail = seg[2]
	}
	switch head {
	case "values":
		return "Edited a configuration value"
	case "files":
		return "Edited a file in the draft"
	case "instances":
		switch method {
		case http.MethodPost:
			return "Added an instance"
		case http.MethodPut:
			return "Updated instance " + arg
		case http.MethodDelete:
			return "Retired instance " + arg
		}
	case "parameters":
		switch method {
		case http.MethodPost:
			return "Added a parameter"
		case http.MethodPut:
			return "Updated a parameter"
		case http.MethodDelete:
			return "Retired a parameter"
		}
	case "changes":
		switch tail {
		case "submit":
			return "Submitted change request #" + arg + " for review"
		case "approve":
			return "Approved change request #" + arg
		case "merge":
			return "Published change request #" + arg
		case "reject":
			return "Rejected change request #" + arg
		case "reopen":
			return "Resumed the work of change request #" + arg
		case "comments":
			return "Commented on change request #" + arg
		case "reviewers":
			return "Assigned reviewers on change request #" + arg
		}
		if method == http.MethodPost {
			return "Staged a draft change"
		}
	case "restore":
		return "Staged a restore to an earlier snapshot"
	case "import":
		return "Imported settings"
	case "init":
		return "Initialized the application"
	case "deinit":
		return "Removed Configer from the repository"
	case "application":
		return "Updated application details"
	case "repo":
		if arg == "sync" {
			return "Synchronized with Git"
		}
		if arg == "findings" {
			return "Acknowledged repository changes"
		}
	case "reconcile":
		return "Reconciled a repository change"
	}
	// Fall back to a readable generic rather than the raw path.
	verb := map[string]string{
		http.MethodPost: "Created", http.MethodPut: "Updated",
		http.MethodPatch: "Updated", http.MethodDelete: "Removed",
	}[method]
	if verb == "" {
		verb = "Changed"
	}
	if head == "" {
		return verb + " a resource"
	}
	return verb + " " + head
}

// requireUser allows any signed-in person (or anyone in single-user mode).
func (h *Hub) requireUser(w http.ResponseWriter, r *http.Request) bool {
	if !h.auth.Enabled() {
		return true
	}
	if _, ok := auth.UserFrom(r.Context()); !ok {
		writeError(w, r, http.StatusUnauthorized, CodeUnauthorized, "sign in to use this deployment")
		return false
	}
	return true
}

// requireWorkspace gates a workspace-level action: adding applications, reading
// the audit trail.
func (h *Hub) requireWorkspace(w http.ResponseWriter, r *http.Request, action string) bool {
	if !h.requireUser(w, r) {
		return false
	}
	return h.allow(w, r, workspaceResource(), action)
}

// myRole reports the caller's own access to one application, so the interface
// can say what they may do.
//
// @Summary     My role on an application
// @Description The caller's access (viewer, editor, approver) to one application, derived from the platform's policies, plus the administrator flag. In single-user mode the caller may do everything.
// @Tags        Platform
// @Produce     json
// @Param       id path string true "Repository id"
// @Success     200 {object} map[string]interface{}
// @Failure     401 {object} APIError "Not signed in"
// @Security    BearerAuth
// @Router      /api/repos/{id}/role [get]
func (h *Hub) myRole(w http.ResponseWriter, r *http.Request) {
	if !h.auth.Enabled() {
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled": false, "role": store.RoleApprover, "admin": true,
		})
		return
	}
	u, ok := auth.UserFrom(r.Context())
	if !ok {
		writeError(w, r, http.StatusUnauthorized, CodeUnauthorized, "sign in to use this deployment")
		return
	}
	g := h.grantFor(r, r.PathValue("id"))
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled": true,
		"role":    g.Role,
		"source":  g.Source,
		"detail":  g.Detail,
		"admin":   u.Admin,
	})
}

// people lists who has signed in to this deployment, so a change can name its
// reviewers. Who may do what is the platform's to say, not this list's.
//
// @Summary     People
// @Description Everyone who has signed in to this deployment, for the reviewer picker. Access is granted in the platform's identity provider, so there are no assignments to list.
// @Tags        Platform
// @Produce     json
// @Param       id path string true "Repository id"
// @Success     200 {object} map[string]interface{}
// @Failure     401 {object} APIError "Not signed in"
// @Security    BearerAuth
// @Router      /api/repos/{id}/members [get]
func (h *Hub) people(w http.ResponseWriter, r *http.Request) {
	if !h.requireUser(w, r) {
		return
	}
	if !h.allow(w, r, h.applicationResource(r.PathValue("id")), actView) {
		return
	}
	users, err := h.platform.ListUsers(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"members": []any{}, "users": users, "enabled": h.auth.Enabled(),
	})
}

// requireAppLifecycle gates a change to an application's place in the
// workspace (renaming or disconnecting it).
func (h *Hub) requireAppLifecycle(w http.ResponseWriter, r *http.Request, repoID string) bool {
	if !h.requireUser(w, r) {
		return false
	}
	return h.allow(w, r, h.applicationResource(repoID), actAdminister)
}

// auditLog serves the newest audit entries.
//
// @Summary     Audit trail
// @Description Audit events across all applications (or one via `?repo=`), newest first, naming who did what. Cursor-paginated: pass `limit` (default 50, max 200) and the previous `nextCursor`. Needs the view_audit permission.
// @Tags        Platform
// @Produce     json
// @Param       repo   query string false "Filter to one application id"
// @Param       limit  query int    false "Page size (default 50, max 200)"
// @Param       cursor query string false "Opaque cursor from the previous page"
// @Success     200 {object} map[string]interface{}
// @Failure     401 {object} APIError "Not signed in"
// @Failure     403 {object} APIError "Not permitted"
// @Security    BearerAuth
// @Router      /api/audit [get]
func (h *Hub) auditLog(w http.ResponseWriter, r *http.Request) {
	if !h.requireWorkspace(w, r, actViewAudit) {
		return
	}
	limit, afterID := pageParams(r)
	evs, err := h.platform.EventsBefore(r.Context(), r.URL.Query().Get("repo"), limit+1, afterID)
	if err != nil {
		writeErr(w, err)
		return
	}
	hasMore := len(evs) > limit
	if hasMore {
		evs = evs[:limit]
	}
	next := ""
	if hasMore && len(evs) > 0 {
		next = encodeCursor(evs[len(evs)-1].ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"events": evs, "items": evs, "nextCursor": next, "hasMore": hasMore,
	})
}

// auditVerify checks the audit hash chain.
//
// @Summary     Verify the audit trail
// @Description Recompute the audit hash chain and report whether the trail is intact, naming the first broken row if not. Needs the view_audit permission.
// @Tags        Platform
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Failure     401 {object} APIError "Not signed in"
// @Failure     403 {object} APIError "Not permitted"
// @Security    BearerAuth
// @Router      /api/audit/verify [get]
func (h *Hub) auditVerify(w http.ResponseWriter, r *http.Request) {
	if !h.requireWorkspace(w, r, actViewAudit) {
		return
	}
	ok, brokenAt, err := h.platform.VerifyAudit(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	resp := map[string]any{"intact": ok}
	if !ok {
		resp["brokenAt"] = brokenAt
	}
	writeJSON(w, http.StatusOK, resp)
}
