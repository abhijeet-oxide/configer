package api

// Platform layer: login-aware role enforcement, per-application member
// management, and the audit trail. Everything degrades gracefully - with no
// OAuth client configured the deployment behaves as the single-user tool it
// always was, and the database is an embedded SQLite file.

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/auth"
	"github.com/abhijeet-oxide/configer/backend/internal/store"
)

// newPlatform opens the platform store and OAuth service from the
// environment. SQLite under dataDir by default; DATABASE_URL selects
// PostgreSQL. OAuth is enabled by GITHUB_OAUTH_CLIENT_ID/SECRET.
func newPlatform(dataDir string) (*store.Store, *auth.Service, error) {
	st, err := store.Open(dataDir, os.Getenv("DATABASE_URL"))
	if err != nil {
		return nil, nil, err
	}
	admins := map[string]bool{}
	for _, a := range strings.Split(os.Getenv("CONFIGER_ADMINS"), ",") {
		if a = strings.TrimSpace(a); a != "" {
			admins[a] = true
		}
	}
	svc := &auth.Service{
		ClientID:      os.Getenv("GITHUB_OAUTH_CLIENT_ID"),
		ClientSecret:  os.Getenv("GITHUB_OAUTH_CLIENT_SECRET"),
		CallbackURL:   os.Getenv("CONFIGER_OAUTH_CALLBACK"),
		APIBase:       os.Getenv("GITHUB_API_URL"),
		WebBase:       os.Getenv("GITHUB_WEB_URL"),
		Store:         st,
		Admins:        admins,
		SecureCookies: cookieSecure(),
	}
	return st, svc, nil
}

// cookieSecure decides whether session cookies get the Secure flag. It is on by
// default in a production deployment (CONFIGER_ENV=production) and can be forced
// either way with CONFIGER_COOKIE_SECURE, so a TLS-terminating proxy in any
// environment can opt in.
func cookieSecure() bool {
	if v := os.Getenv("CONFIGER_COOKIE_SECURE"); v != "" {
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "1", "true", "yes", "on":
			return true
		default:
			return false
		}
	}
	return strings.EqualFold(strings.TrimSpace(os.Getenv("CONFIGER_ENV")), "production")
}

// defaultRole is the capability users get on applications where no explicit
// role is assigned. It defaults to viewer - the least privilege - so a fresh
// deployment does not hand every authenticated user edit rights on every
// application. Operators who want the old open-by-default behavior set
// CONFIGER_DEFAULT_ROLE=editor explicitly.
func defaultRole() store.Role {
	if r := store.Role(os.Getenv("CONFIGER_DEFAULT_ROLE")); r.Valid() {
		return r
	}
	return store.RoleViewer
}

// roleRank orders roles by capability.
func roleRank(r store.Role) int {
	switch r {
	case store.RoleApprover:
		return 3
	case store.RoleEditor:
		return 2
	case store.RoleViewer:
		return 1
	}
	return 0
}

// requiredRole derives the capability a request needs: reads are viewer+,
// writes editor+, and publishing (merge) approver.
func requiredRole(r *http.Request) store.Role {
	if strings.HasSuffix(r.URL.Path, "/merge") {
		return store.RoleApprover
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return store.RoleViewer
	default:
		return store.RoleEditor
	}
}

// effectiveRole computes a user's role on one application: deployment admins
// approve everywhere; an explicit membership wins; otherwise the deployment
// default applies (by default viewer, so every authenticated user can read
// every application in the shared registry but not change it until granted a
// role).
func (h *Hub) effectiveRole(r *http.Request, repoID string, u store.User) store.Role {
	if u.Admin {
		return store.RoleApprover
	}
	if role, err := h.platform.MemberRole(r.Context(), repoID, u.Login); err == nil {
		return role
	} else if !errors.Is(err, store.ErrNotFound) {
		return store.RoleViewer // database trouble: fail safe, never up
	}
	return defaultRole()
}

// authorize gates one repo-scoped request. With OAuth disabled everything is
// allowed (single-user mode). With it enabled: unauthenticated requests are
// rejected, and the user's effective role must cover the request.
func (h *Hub) authorize(w http.ResponseWriter, r *http.Request, repoID string) bool {
	if !h.auth.Enabled() {
		return true
	}
	u, ok := auth.UserFrom(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in to use this deployment"})
		return false
	}
	need := requiredRole(r)
	have := h.effectiveRole(r, repoID, u)
	if roleRank(have) < roleRank(need) {
		writeJSON(w, http.StatusForbidden, map[string]string{
			"error": "your role (" + string(have) + ") does not allow this action; it needs " + string(need),
		})
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
		case "merge":
			return "Published change request #" + arg
		case "reject":
			return "Rejected change request #" + arg
		case "comments":
			return "Commented on change request #" + arg
		case "reviewers":
			return "Assigned reviewers on change request #" + arg
		}
		if method == http.MethodPost {
			return "Staged a draft change"
		}
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

// --- member management -----------------------------------------------------------

// members lists explicit role assignments plus every known user, so the UI
// can offer assignments without a separate user directory.
// members lists role assignments for one application.
//
// @Summary     List members
// @Description Explicit role assignments for one application plus the known-user directory, so the UI can offer assignments. Admin-only.
// @Tags        Platform
// @Produce     json
// @Param       id path string true "Repository id"
// @Success     200 {object} map[string]interface{}
// @Failure     401 {object} APIError "Not signed in"
// @Failure     403 {object} APIError "Admin only"
// @Security    CookieSession
// @Router      /api/repos/{id}/members [get]
func (h *Hub) members(w http.ResponseWriter, r *http.Request) {
	// The member roster includes the full user directory, so it is admin-only,
	// matching the setMember/removeMember writes it accompanies.
	if !h.requireAdmin(w, r) {
		return
	}
	id := r.PathValue("id")
	ms, err := h.platform.ListMembers(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	users, err := h.platform.ListUsers(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"members":     ms,
		"users":       users,
		"defaultRole": defaultRole(),
		"enabled":     h.auth.Enabled(),
	})
}

// setMember assigns a role (admins only when auth is enabled).
// setMember assigns a role on one application.
//
// @Summary     Assign a role
// @Description Assign a role (viewer, editor, approver) to a user on one application. Admin-only.
// @Tags        Platform
// @Accept      json
// @Produce     json
// @Param       id   path string           true "Repository id"
// @Param       body body SetMemberRequest true "Login + role"
// @Success     200 {object} OKResponse
// @Failure     400 {object} APIError "Missing login or invalid role"
// @Failure     401 {object} APIError "Not signed in"
// @Failure     403 {object} APIError "Admin only"
// @Security    CookieSession
// @Router      /api/repos/{id}/members [put]
func (h *Hub) setMember(w http.ResponseWriter, r *http.Request) {
	if !h.requireAdmin(w, r) {
		return
	}
	var req struct {
		Login string     `json:"login"`
		Role  store.Role `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Login == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "login and role are required")
		return
	}
	if !req.Role.Valid() {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "role must be viewer, editor or approver")
		return
	}
	repoID := r.PathValue("id")
	if err := h.platform.SetMember(r.Context(), store.Member{Repo: repoID, Login: req.Login, Role: req.Role}); err != nil {
		writeErr(w, err)
		return
	}
	h.auditHub(r, repoID, "Granted role "+string(req.Role)+" to "+req.Login, "PUT /repos/"+repoID+"/members")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// removeMember clears an explicit assignment (back to the deployment default).
// removeMember clears an explicit role assignment.
//
// @Summary     Remove a member's role
// @Description Clear a user's explicit role on one application (back to the deployment default). Admin-only.
// @Tags        Platform
// @Produce     json
// @Param       id    path string true "Repository id"
// @Param       login path string true "User login"
// @Success     200 {object} OKResponse
// @Failure     401 {object} APIError "Not signed in"
// @Failure     403 {object} APIError "Admin only"
// @Security    CookieSession
// @Router      /api/repos/{id}/members/{login} [delete]
func (h *Hub) removeMember(w http.ResponseWriter, r *http.Request) {
	if !h.requireAdmin(w, r) {
		return
	}
	repoID, login := r.PathValue("id"), r.PathValue("login")
	if err := h.platform.RemoveMember(r.Context(), repoID, login); err != nil {
		writeErr(w, err)
		return
	}
	h.auditHub(r, repoID, "Revoked the explicit role of "+login, "DELETE /repos/"+repoID+"/members/"+login)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// requireUser allows any signed-in user (or anyone when auth is disabled -
// single-user mode has no login). Use it to gate hub-level endpoints that leak
// nothing role-specific but must not be reachable anonymously on a multi-user
// deployment (e.g. the server-token-backed GitHub browsing endpoints).
func (h *Hub) requireUser(w http.ResponseWriter, r *http.Request) bool {
	if !h.auth.Enabled() {
		return true
	}
	if _, ok := auth.UserFrom(r.Context()); !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in to use this deployment"})
		return false
	}
	return true
}

// requireAdmin allows deployment admins (or anyone when auth is disabled -
// single-user mode has no roles to protect).
func (h *Hub) requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	if !h.auth.Enabled() {
		return true
	}
	u, ok := auth.UserFrom(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in to use this deployment"})
		return false
	}
	if !u.Admin {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only deployment admins can manage members (CONFIGER_ADMINS)"})
		return false
	}
	return true
}

// auditLog serves the newest audit entries. The trail spans every application
// and names who did what, so it is admin-only.
// auditLog serves the newest audit entries.
//
// @Summary     Audit trail
// @Description Audit events across all applications (or one via `?repo=`), newest first, naming who did what. Cursor-paginated: pass `limit` (default 50, max 200) and the previous `nextCursor`. Admin-only.
// @Tags        Platform
// @Produce     json
// @Param       repo   query string false "Filter to one application id"
// @Param       limit  query int    false "Page size (default 50, max 200)"
// @Param       cursor query string false "Opaque cursor from the previous page"
// @Success     200 {object} map[string]interface{}
// @Failure     401 {object} APIError "Not signed in"
// @Failure     403 {object} APIError "Admin only"
// @Security    CookieSession
// @Router      /api/audit [get]
func (h *Hub) auditLog(w http.ResponseWriter, r *http.Request) {
	if !h.requireAdmin(w, r) {
		return
	}
	limit, afterID := pageParams(r)
	// Fetch one extra row to know whether a further page exists.
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
	// `events` is kept for backward compatibility; `items`/`nextCursor`/`hasMore`
	// are the standard pagination envelope.
	writeJSON(w, http.StatusOK, map[string]any{
		"events": evs, "items": evs, "nextCursor": next, "hasMore": hasMore,
	})
}

// auditVerify recomputes the audit hash chain and reports whether the trail is
// intact, naming the first broken row if not. Admin-only, like the trail.
// auditVerify checks the audit hash chain.
//
// @Summary     Verify the audit trail
// @Description Recompute the audit hash chain and report whether the trail is intact, naming the first broken row if not. Admin-only.
// @Tags        Platform
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Failure     401 {object} APIError "Not signed in"
// @Failure     403 {object} APIError "Admin only"
// @Security    CookieSession
// @Router      /api/audit/verify [get]
func (h *Hub) auditVerify(w http.ResponseWriter, r *http.Request) {
	if !h.requireAdmin(w, r) {
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
