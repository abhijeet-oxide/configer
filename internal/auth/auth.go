// Package auth signs requests in with the platform's identity provider and asks
// the platform's policy engine what they may do.
//
// ArtiAuto has no sign-in of its own. The browser holds a token from the
// platform's ZITADEL (the same one Software Gateway accepts), the backend
// verifies it with the platform's pkg/authz, and every permission is a question
// put to the platform's Cerbos. With no issuer configured the deployment runs in
// single-user mode: every request acts as the local user and is allowed
// everything, which is what a laptop running `task dev` wants.
package auth

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/abhijeet-oxide/configer/internal/store"
	"github.com/abhijeet-oxide/softwareGateway/pkg/authz"
)

type ctxKey int

const userKey ctxKey = 0

// Service holds the verifier and the policy engine. A nil Verifier is
// single-user mode.
type Service struct {
	Verifier *authz.Verifier
	// Verify replaces Verifier.Verify. Tests set it to stand in for the
	// identity provider; nothing in a deployment does.
	Verify func(ctx context.Context, raw string) (authz.Identity, error)
	Engine authz.Engine
	Store  *store.Store
	// Problem names, for the deployment log, why sign-in is off although it was
	// asked for. It never reaches a screen.
	Problem string
	// AdminRole is the organization role that makes somebody an administrator
	// of this deployment, for the screens that say so.
	AdminRole string

	seen sync.Map
}

// Enabled reports whether requests are signed in with the platform.
func (s *Service) Enabled() bool { return s != nil && (s.Verifier != nil || s.Verify != nil) }

func (s *Service) verify(ctx context.Context, raw string) (authz.Identity, error) {
	if s.Verify != nil {
		return s.Verify(ctx, raw)
	}
	return s.Verifier.Verify(ctx, raw)
}

// ConfigProblem is why sign-in is off despite having been configured.
func (s *Service) ConfigProblem() string {
	if s == nil {
		return ""
	}
	return s.Problem
}

// UserFrom returns the signed-in person carried by the request context.
func UserFrom(ctx context.Context) (store.User, bool) {
	u, ok := ctx.Value(userKey).(store.User)
	return u, ok
}

// WithUser puts a signed-in person on a context, with the platform identity
// the policy engine is asked about.
func WithUser(ctx context.Context, u store.User) context.Context {
	return context.WithValue(ctx, userKey, u)
}

// WithIdentity puts both halves on a context: the platform identity the policy
// engine reads and the person the rest of ArtiAuto names. Tests use it to stand
// in for a verified token.
func (s *Service) WithIdentity(ctx context.Context, id authz.Identity) context.Context {
	return WithUser(authz.NewContext(ctx, id), s.userOf(id))
}

func (s *Service) userOf(id authz.Identity) store.User {
	login := id.Email
	if login == "" {
		login = id.Subject
	}
	admin := s.AdminRole != "" && id.HasOrgRole(s.AdminRole)
	return store.User{Login: login, Name: id.Name, Email: id.Email, Admin: admin}
}

// Middleware verifies the bearer token when there is one. It never refuses a
// request without one: each route decides what it needs, so the health probe
// and the capabilities list answer before anybody has signed in. A token that
// does not verify is refused, because a caller who sent one expects to be
// somebody.
func (s *Service) Middleware(next http.Handler) http.Handler {
	if !s.Enabled() {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := authz.BearerToken(r)
		if raw == "" {
			next.ServeHTTP(w, r.WithContext(authz.NewContext(r.Context(), authz.Anonymous)))
			return
		}
		id, err := s.verify(r.Context(), raw)
		if err != nil {
			slog.Warn("token rejected", slog.String("path", r.URL.Path), slog.Any("error", err))
			writeRefusal(w, r, http.StatusUnauthorized, "your sign-in is not valid; sign in again")
			return
		}
		u := s.userOf(id)
		s.remember(r.Context(), u)
		next.ServeHTTP(w, r.WithContext(WithUser(authz.NewContext(r.Context(), id), u)))
	})
}

// remember records a person once per process, so the audit trail and the
// change requests can show a name for a login.
func (s *Service) remember(ctx context.Context, u store.User) {
	if s.Store == nil || u.Login == "" {
		return
	}
	if _, done := s.seen.LoadOrStore(u.Login, true); done {
		return
	}
	if err := s.Store.UpsertUser(ctx, u); err != nil {
		s.seen.Delete(u.Login)
		slog.Warn("could not record a signed-in person", slog.String("login", u.Login), slog.Any("error", err))
	}
}

// Allowed answers which of actions the caller may take on res. Single-user mode
// allows everything; a signed-in deployment with no policy engine allows
// nothing, because "cannot ask" is not "yes".
func (s *Service) Allowed(ctx context.Context, res authz.Resource, actions ...string) (map[string]bool, error) {
	out := make(map[string]bool, len(actions))
	if !s.Enabled() {
		for _, a := range actions {
			out[a] = true
		}
		return out, nil
	}
	if s.Engine == nil {
		for _, a := range actions {
			out[a] = false
		}
		return out, nil
	}
	return s.Engine.Check(ctx, authz.FromContext(ctx), res, actions...)
}

// Routes mounts what the browser asks about itself.
func (s *Service) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/auth/me", s.me)
	mux.HandleFunc("GET /api/v1/whoami", s.whoami)
}

// me answers who the caller is, in the shape the interface has always read.
//
// @Summary     Who am I
// @Description The signed-in person, and whether this deployment signs people in at all. Single-user mode answers enabled=false.
// @Tags        Platform
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Router      /api/auth/me [get]
func (s *Service) me(w http.ResponseWriter, r *http.Request) {
	u, ok := UserFrom(r.Context())
	body := map[string]any{"enabled": s.Enabled()}
	if ok {
		body["user"] = u
	}
	writeJSON(w, http.StatusOK, body)
}

// whoami is the platform's /whoami, so the interface's shared sign-in code
// reads the same answer from either application.
//
// @Summary     Platform identity
// @Description The verified identity in the platform's shape: subject, tenant, organization roles and product roles.
// @Tags        Platform
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Router      /api/v1/whoami [get]
func (s *Service) whoami(w http.ResponseWriter, r *http.Request) {
	if !s.Enabled() {
		writeJSON(w, http.StatusOK, map[string]any{
			"subject": "local", "authenticated": false, "method": "anonymous",
			"orgRoles": []string{}, "products": map[string][]string{},
		})
		return
	}
	authz.WhoAmI(w, r)
}

// GitHubAPIBase is the GitHub API root the server-side credential talks to.
func (s *Service) GitHubAPIBase() string {
	if b := strings.TrimSpace(os.Getenv("GITHUB_API_URL")); b != "" {
		return strings.TrimSuffix(b, "/")
	}
	return "https://api.github.com"
}

func writeRefusal(w http.ResponseWriter, _ *http.Request, status int, detail string) {
	writeJSON(w, status, map[string]string{"error": detail, "code": "unauthorized"})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
