// Package auth implements GitHub OAuth login and cookie sessions. When no
// OAuth client is configured (GITHUB_OAUTH_CLIENT_ID unset) the deployment
// runs in single-user mode: every request acts as the anonymous local user
// and no login surface appears — self-hosted simplicity stays intact.
package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/store"
)

// ctxKey carries the authenticated user through the request context.
type ctxKey int

const userKey ctxKey = 0

// SessionCookie names the browser session cookie.
const SessionCookie = "configer_session"

// sessionTTL is how long a login lasts.
const sessionTTL = 30 * 24 * time.Hour

// Service wires the OAuth client, the platform store, and the deployment's
// admin list.
type Service struct {
	ClientID     string
	ClientSecret string
	// CallbackURL is this deployment's /api/auth/callback URL as GitHub
	// should redirect to it (public address, not localhost, in production).
	CallbackURL string
	// APIBase points at GitHub's API (override for GitHub Enterprise).
	APIBase string
	// WebBase points at GitHub's web login (override for GitHub Enterprise).
	WebBase string
	Store   *store.Store
	// Admins are logins that may manage members (comma list from env).
	Admins map[string]bool
	// HTTP is the outbound client (test seam).
	HTTP *http.Client

	// tokens caches each signed-in user's GitHub access token, in memory
	// only — never written to the store or sent to the browser. It lets the
	// server browse repositories and branches on the user's behalf (the New
	// Application flow). After a server restart the cache is empty until the
	// user signs in again, which is a plain re-login, not an error.
	mu     sync.Mutex
	tokens map[string]string
}

// Enabled reports whether OAuth login is configured.
func (s *Service) Enabled() bool { return s != nil && s.ClientID != "" && s.Store != nil }

func (s *Service) apiBase() string {
	if s.APIBase != "" {
		return strings.TrimSuffix(s.APIBase, "/")
	}
	return "https://api.github.com"
}

func (s *Service) webBase() string {
	if s.WebBase != "" {
		return strings.TrimSuffix(s.WebBase, "/")
	}
	return "https://github.com"
}

func (s *Service) http() *http.Client {
	if s.HTTP != nil {
		return s.HTTP
	}
	return &http.Client{Timeout: 15 * time.Second}
}

// rememberToken caches a user's GitHub access token for the lifetime of this
// process.
func (s *Service) rememberToken(login, token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tokens == nil {
		s.tokens = map[string]string{}
	}
	s.tokens[login] = token
}

// GitHubToken returns the cached GitHub access token for a signed-in user,
// or "" when none is known (session predates this process).
func (s *Service) GitHubToken(login string) string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tokens[login]
}

// GitHubAPIBase exposes the GitHub API root (Enterprise-aware) for callers
// that talk to GitHub on a user's behalf.
func (s *Service) GitHubAPIBase() string {
	if s == nil {
		return "https://api.github.com"
	}
	return s.apiBase()
}

// UserFrom returns the authenticated user carried by the request context.
func UserFrom(ctx context.Context) (store.User, bool) {
	u, ok := ctx.Value(userKey).(store.User)
	return u, ok
}

// Middleware resolves the session cookie into a request-context user. It
// never rejects: endpoints decide their own required role.
func (s *Service) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.Enabled() {
			if c, err := r.Cookie(SessionCookie); err == nil && c.Value != "" {
				if u, err := s.Store.SessionUser(r.Context(), c.Value); err == nil {
					r = r.WithContext(context.WithValue(r.Context(), userKey, u))
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// Routes mounts the auth endpoints on mux.
func (s *Service) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/auth/me", s.me)
	mux.HandleFunc("GET /api/auth/login", s.login)
	mux.HandleFunc("GET /api/auth/callback", s.callback)
	mux.HandleFunc("POST /api/auth/logout", s.logout)
}

// me reports the current identity and whether login is configured at all.
func (s *Service) me(w http.ResponseWriter, r *http.Request) {
	if !s.Enabled() {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	u, ok := UserFrom(r.Context())
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "user": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "user": u})
}

// login redirects the browser into GitHub's authorize page.
func (s *Service) login(w http.ResponseWriter, r *http.Request) {
	if !s.Enabled() {
		http.Error(w, "login is not configured on this deployment", http.StatusNotImplemented)
		return
	}
	state := randomToken()
	http.SetCookie(w, &http.Cookie{
		Name: "configer_oauth_state", Value: state, Path: "/",
		HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: 600,
	})
	// The repo scope lets Configer list the user's repositories (their own
	// and their orgs') and clone private ones during application creation.
	q := url.Values{
		"client_id": {s.ClientID},
		"scope":     {"read:user user:email repo"},
		"state":     {state},
	}
	if s.CallbackURL != "" {
		q.Set("redirect_uri", s.CallbackURL)
	}
	http.Redirect(w, r, s.webBase()+"/login/oauth/authorize?"+q.Encode(), http.StatusFound)
}

// callback exchanges the code, records the user, opens a session, and sends
// the browser back to the app.
func (s *Service) callback(w http.ResponseWriter, r *http.Request) {
	if !s.Enabled() {
		http.Error(w, "login is not configured on this deployment", http.StatusNotImplemented)
		return
	}
	if c, err := r.Cookie("configer_oauth_state"); err != nil || c.Value == "" || c.Value != r.URL.Query().Get("state") {
		http.Error(w, "state mismatch; restart the login", http.StatusBadRequest)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		http.Error(w, "missing code", http.StatusBadRequest)
		return
	}

	token, err := s.exchange(r.Context(), code)
	if err != nil {
		http.Error(w, "GitHub token exchange failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	ghUser, err := s.fetchUser(r.Context(), token)
	if err != nil {
		http.Error(w, "GitHub user lookup failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	ghUser.Admin = s.Admins[ghUser.Login]
	ghUser.CreatedAt = time.Now().UTC()
	s.rememberToken(ghUser.Login, token)
	if err := s.Store.UpsertUser(r.Context(), ghUser); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	session := randomToken()
	if err := s.Store.CreateSession(r.Context(), session, ghUser.Login, sessionTTL); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = s.Store.PruneSessions(r.Context())
	http.SetCookie(w, &http.Cookie{
		Name: SessionCookie, Value: session, Path: "/",
		HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: int(sessionTTL.Seconds()),
	})
	http.SetCookie(w, &http.Cookie{Name: "configer_oauth_state", Value: "", Path: "/", MaxAge: -1})
	http.Redirect(w, r, "/", http.StatusFound)
}

func (s *Service) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(SessionCookie); err == nil && c.Value != "" && s.Enabled() {
		_ = s.Store.DeleteSession(r.Context(), c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: SessionCookie, Value: "", Path: "/", MaxAge: -1})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// exchange trades the OAuth code for an access token.
func (s *Service) exchange(ctx context.Context, code string) (string, error) {
	form := url.Values{
		"client_id":     {s.ClientID},
		"client_secret": {s.ClientSecret},
		"code":          {code},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.webBase()+"/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := s.http().Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var out struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error_description"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out); err != nil {
		return "", err
	}
	if out.AccessToken == "" {
		if out.Error != "" {
			return "", errors.New(out.Error)
		}
		return "", fmt.Errorf("no access token (HTTP %d)", res.StatusCode)
	}
	return out.AccessToken, nil
}

// fetchUser loads the GitHub identity behind a token.
func (s *Service) fetchUser(ctx context.Context, token string) (store.User, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.apiBase()+"/user", nil)
	if err != nil {
		return store.User{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := s.http().Do(req)
	if err != nil {
		return store.User{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return store.User{}, fmt.Errorf("HTTP %d from GitHub", res.StatusCode)
	}
	var gh struct {
		Login     string `json:"login"`
		Name      string `json:"name"`
		Email     string `json:"email"`
		AvatarURL string `json:"avatar_url"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&gh); err != nil {
		return store.User{}, err
	}
	if gh.Login == "" {
		return store.User{}, errors.New("GitHub returned no login")
	}
	return store.User{Login: gh.Login, Name: gh.Name, Email: gh.Email, AvatarURL: gh.AvatarURL}, nil
}

func randomToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
