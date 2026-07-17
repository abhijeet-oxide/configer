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
	"strconv"
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
		ClientID:     os.Getenv("GITHUB_OAUTH_CLIENT_ID"),
		ClientSecret: os.Getenv("GITHUB_OAUTH_CLIENT_SECRET"),
		CallbackURL:  os.Getenv("CONFIGER_OAUTH_CALLBACK"),
		APIBase:      os.Getenv("GITHUB_API_URL"),
		WebBase:      os.Getenv("GITHUB_WEB_URL"),
		Store:        st,
		Admins:       admins,
	}
	return st, svc, nil
}

// defaultRole is the capability users get on applications where no explicit
// role is assigned (CONFIGER_DEFAULT_ROLE, default editor).
func defaultRole() store.Role {
	if r := store.Role(os.Getenv("CONFIGER_DEFAULT_ROLE")); r.Valid() {
		return r
	}
	return store.RoleEditor
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
// default applies (every authenticated user sees every application - the
// registry is shared, initialize once for everyone).
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
func (h *Hub) members(w http.ResponseWriter, r *http.Request) {
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
func (h *Hub) setMember(w http.ResponseWriter, r *http.Request) {
	if !h.requireAdmin(w, r) {
		return
	}
	var req struct {
		Login string     `json:"login"`
		Role  store.Role `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Login == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "login and role are required"})
		return
	}
	if !req.Role.Valid() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "role must be viewer, editor or approver"})
		return
	}
	if err := h.platform.SetMember(r.Context(), store.Member{Repo: r.PathValue("id"), Login: req.Login, Role: req.Role}); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// removeMember clears an explicit assignment (back to the deployment default).
func (h *Hub) removeMember(w http.ResponseWriter, r *http.Request) {
	if !h.requireAdmin(w, r) {
		return
	}
	if err := h.platform.RemoveMember(r.Context(), r.PathValue("id"), r.PathValue("login")); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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

// auditLog serves the newest audit entries.
func (h *Hub) auditLog(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	evs, err := h.platform.Events(r.Context(), r.URL.Query().Get("repo"), limit)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": evs})
}
