// Package auth implements GitHub OAuth login and cookie sessions. When no
// OAuth client is configured (GITHUB_OAUTH_CLIENT_ID unset) the deployment
// runs in single-user mode: every request acts as the anonymous local user
// and no login surface appears - self-hosted simplicity stays intact.
package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/httpx"
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
	// AppURL is where the user-facing app is served when that is NOT the same
	// address as this API (a separately-hosted SPA, or the dev server in front
	// of the backend). Login returns the browser there instead of to the API
	// host, which serves no page at /applications and would 404.
	AppURL string
	// APIBase points at GitHub's API (override for GitHub Enterprise).
	APIBase string
	// WebBase points at GitHub's web login (override for GitHub Enterprise).
	WebBase string
	Store   *store.Store
	// Admins are logins that may manage members (comma list from env).
	Admins map[string]bool
	// SecureCookies marks the session and OAuth-state cookies Secure, so a
	// browser only ever sends them over HTTPS. Enable it in any TLS-served
	// deployment (production); leave it off for plain-HTTP localhost so login
	// still works in development.
	SecureCookies bool
	// HTTP is the outbound client (test seam).
	HTTP *http.Client

	// tokens caches each signed-in user's GitHub access token, in memory
	// only - never written to the store or sent to the browser. It lets the
	// server browse repositories and branches on the user's behalf (the New
	// Application flow). After a server restart the cache is empty until the
	// user signs in again, which is a plain re-login, not an error.
	mu     sync.Mutex
	tokens map[string]string
}

// Enabled reports whether OAuth login is configured.
// Enabled reports whether GitHub sign-in can actually complete. Both halves of
// the OAuth credential are required: with only the client id, the login link
// would render and then fail at the token exchange, which is worse than not
// offering it at all.
func (s *Service) Enabled() bool {
	return s != nil && s.ClientID != "" && s.ClientSecret != "" && s.Store != nil
}

// ConfigProblem names, for the deployment log, what is missing when sign-in is
// off despite someone having started to configure it. It is never shown to an
// end user - the UI says only that the integration is unavailable.
func (s *Service) ConfigProblem() string {
	switch {
	case s == nil || s.Store == nil:
		return "the platform database is unavailable"
	case s.ClientID == "" && s.ClientSecret == "":
		return "GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET are not set"
	case s.ClientSecret == "":
		return "GITHUB_OAUTH_CLIENT_SECRET is not set (the client id alone cannot complete a login)"
	case s.ClientID == "":
		return "GITHUB_OAUTH_CLIENT_ID is not set"
	}
	return ""
}

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
	return httpx.Client(15 * time.Second)
}

// callbackURL is the redirect_uri GitHub sends the browser back to. An explicit
// CONFIGER_OAUTH_CALLBACK wins; otherwise it is derived from the request that
// began login, so a deployment "just works" at whatever public URL it is served
// from, without a second env var to keep in sync. Proxy headers
// (X-Forwarded-Proto / X-Forwarded-Host) are honored so it stays correct behind
// TLS-terminating load balancers. The SAME value is sent at authorize and at
// token exchange, which GitHub requires to match.
func (s *Service) callbackURL(r *http.Request) string {
	if s.CallbackURL != "" {
		return s.CallbackURL
	}
	return requestOrigin(r) + "/api/auth/callback"
}

// requestOrigin is the scheme://host this request arrived on, honoring the
// proxy headers a TLS-terminating load balancer sets.
func requestOrigin(r *http.Request) string {
	scheme := "http"
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = p
	} else if r.TLS != nil {
		scheme = "https"
	}
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	return scheme + "://" + host
}

// originOf reduces a URL to scheme://host, or "" when it carries neither.
func originOf(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// isLoopback reports whether an origin points at this machine. A developer runs
// the UI and the API on two loopback ports, so those two count as one site.
func isLoopback(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// appOrigin is where the USER-FACING app is served for this request. The API
// and the app are often not the same address (a separately-hosted SPA, or the
// dev server proxying to the backend), and sending the browser back to the API
// address lands it on a path that serves no page. An explicitly configured app
// address wins; otherwise the page that started the login is trusted when it
// belongs to this deployment; otherwise the API's own address is used.
func (s *Service) appOrigin(r *http.Request) string {
	if o := originOf(s.AppURL); o != "" {
		return o
	}
	if o := originOf(r.Header.Get("Referer")); o != "" && s.trustedOrigin(r, o) {
		return o
	}
	return requestOrigin(r)
}

// trustedOrigin reports whether a browser-supplied origin may receive the
// post-login redirect. Anything else would make login an open redirect.
func (s *Service) trustedOrigin(r *http.Request, origin string) bool {
	if o := originOf(s.AppURL); o != "" {
		return strings.EqualFold(origin, o)
	}
	if strings.EqualFold(origin, requestOrigin(r)) {
		return true
	}
	return isLoopback(origin) && isLoopback(requestOrigin(r))
}

// safeReturn keeps the post-login redirect on this site: a local absolute path
// only (never "//host" or an absolute URL), defaulting to the app root. This
// preserves where the user was (e.g. mid add-application) without becoming an
// open redirect.
func safeReturn(raw string) string {
	if raw == "" || !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") {
		return "/"
	}
	if u, err := url.Parse(raw); err != nil || u.Host != "" || u.Scheme != "" {
		return "/"
	}
	// /api/... is the service, not a page: returning there after login would
	// show raw JSON instead of the app.
	if strings.HasPrefix(raw, "/api/") {
		return "/"
	}
	return raw
}

// returnTarget resolves the full address to send the browser to after login:
// the page the user came from, on the origin that actually serves the app. An
// absolute URL is accepted only when it belongs to this deployment.
func (s *Service) returnTarget(r *http.Request, raw string) string {
	if raw == "" {
		// No explicit request: come back to the page that started the login.
		if ref := r.Header.Get("Referer"); ref != "" {
			if u, err := url.Parse(ref); err == nil {
				if o := originOf(ref); o == "" || s.trustedOrigin(r, o) {
					raw = u.RequestURI()
				}
			}
		}
	}
	if o := originOf(raw); o != "" {
		if !s.trustedOrigin(r, o) {
			return s.appOrigin(r) + "/"
		}
		u, err := url.Parse(raw)
		if err != nil {
			return s.appOrigin(r) + "/"
		}
		return o + safeReturn(u.RequestURI())
	}
	return s.appOrigin(r) + safeReturn(raw)
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

// GitHubGrantURL is where a user grants this OAuth app access to one of their
// organizations. An org with OAuth App access restrictions hides its
// repositories until an owner approves the app (or approves the user's
// request), and this page is where that is done - so the UI can point at it
// instead of leaving an org looking empty for no stated reason.
func (s *Service) GitHubGrantURL() string {
	if s == nil || s.ClientID == "" {
		return ""
	}
	return s.webBase() + "/settings/connections/applications/" + s.ClientID
}

// UserFrom returns the authenticated user carried by the request context.
func UserFrom(ctx context.Context) (store.User, bool) {
	u, ok := ctx.Value(userKey).(store.User)
	return u, ok
}

// WithUser puts an authenticated user on a context. Middleware does this from
// the session cookie; it is exported so a test can exercise a signed-in path
// without standing up a session store.
func WithUser(ctx context.Context, u store.User) context.Context {
	return context.WithValue(ctx, userKey, u)
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
//
// @Summary     Current identity
// @Description Whether login is configured on this deployment, and who is signed in. Returns `{enabled:false}` in single-user mode.
// @Tags        Platform
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Router      /api/auth/me [get]
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
//
// @Summary     Begin GitHub login
// @Description Redirect the browser into GitHub's OAuth authorize page. Returns 501 when login is not configured.
// @Tags        Platform
// @Success     302 "Redirect to GitHub"
// @Failure     501 {string} string "Login not configured"
// @Router      /api/auth/login [get]
func (s *Service) login(w http.ResponseWriter, r *http.Request) {
	if !s.Enabled() {
		http.Error(w, "login is not configured on this deployment", http.StatusNotImplemented)
		return
	}
	state := randomToken()
	http.SetCookie(w, &http.Cookie{
		Name: "configer_oauth_state", Value: state, Path: "/",
		HttpOnly: true, Secure: s.SecureCookies, SameSite: http.SameSiteLaxMode, MaxAge: 600,
	})
	// Remember where the user was so login returns them there (e.g. mid
	// add-application) instead of always dumping them on the start page - and
	// on the address that actually serves the app, not the API's own.
	ret := s.returnTarget(r, r.URL.Query().Get("return_to"))
	http.SetCookie(w, &http.Cookie{
		Name: "configer_oauth_return", Value: ret, Path: "/",
		HttpOnly: true, Secure: s.SecureCookies, SameSite: http.SameSiteLaxMode, MaxAge: 600,
	})
	// The repo scope lets Configer list the user's repositories (their own
	// and their orgs') and clone private ones during application creation.
	// read:org is what lets the picker NAME an organization it can see no
	// repositories in: without it an org whose owners have not approved this
	// OAuth app is simply invisible, and the user is left concluding their
	// repositories are missing rather than that access needs granting.
	q := url.Values{
		"client_id":    {s.ClientID},
		"scope":        {"read:user user:email repo read:org"},
		"state":        {state},
		"redirect_uri": {s.callbackURL(r)},
	}
	http.Redirect(w, r, s.webBase()+"/login/oauth/authorize?"+q.Encode(), http.StatusFound)
}

// callback exchanges the code, records the user, opens a session, and sends
// the browser back to the app.
//
// @Summary     GitHub OAuth callback
// @Description Exchange the OAuth code, record the user, open a session cookie, and redirect back to the app. Invoked by GitHub, not called directly by clients.
// @Tags        Platform
// @Param       code  query string false "OAuth code"
// @Param       state query string false "CSRF state"
// @Success     302 "Redirect to the app with a session cookie"
// @Failure     400 {string} string "Invalid state or code exchange failed"
// @Failure     501 {string} string "Login not configured"
// @Router      /api/auth/callback [get]
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

	// GitHub requires the token-exchange redirect_uri to match the one used at
	// authorize, so derive it the same way here.
	token, err := s.exchange(r.Context(), code, s.callbackURL(r))
	if err != nil {
		http.Error(w, "GitHub token exchange failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	ghUser, err := s.fetchUser(r.Context(), token)
	if err != nil {
		http.Error(w, "GitHub user lookup failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	ghUser.Admin = s.isAdmin(r.Context(), ghUser.Login)
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
	_ = s.Store.Audit(r.Context(), store.Event{
		Login: ghUser.Login, Action: "Signed in", Detail: "GET /api/auth/callback",
	})
	http.SetCookie(w, &http.Cookie{
		Name: SessionCookie, Value: session, Path: "/",
		HttpOnly: true, Secure: s.SecureCookies, SameSite: s.sameSite(), MaxAge: int(sessionTTL.Seconds()),
	})
	http.SetCookie(w, &http.Cookie{Name: "configer_oauth_state", Value: "", Path: "/", MaxAge: -1})
	// Return the user to where they started login (re-validated: only a page
	// this deployment serves).
	ret := s.appOrigin(r) + "/"
	if c, err := r.Cookie("configer_oauth_return"); err == nil && c.Value != "" {
		ret = s.returnTarget(r, c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: "configer_oauth_return", Value: "", Path: "/", MaxAge: -1})
	http.Redirect(w, r, ret, http.StatusFound)
}

// isAdmin decides whether a signing-in user administers this deployment.
//
// A configured admin list is the authority. Without one, the person who
// installs a deployment would otherwise have no way to administer it: nobody
// can manage members or read the audit trail, and the UI can only say "ask an
// administrator" to the very person who is one. So the FIRST user to sign in
// on an empty deployment becomes its administrator, once, and that grant is
// stored - later users are ordinary users. An existing stored grant is always
// preserved, so an admin does not lose the role by signing in again.
func (s *Service) isAdmin(ctx context.Context, login string) bool {
	if s.Admins[login] {
		return true
	}
	if u, err := s.Store.GetUser(ctx, login); err == nil && u.Admin {
		return true
	}
	if len(s.Admins) > 0 {
		return false
	}
	users, err := s.Store.ListUsers(ctx)
	if err != nil || len(users) > 0 {
		return false
	}
	slog.Info("first sign-in on a deployment with no configured administrators: granting the administrator role",
		slog.String("login", login),
		slog.String("hint", "set CONFIGER_ADMINS to choose administrators explicitly"))
	return true
}

// sameSite chooses the session cookie's SameSite policy. When cookies are
// served over TLS (production), None lets the single-page app carry the session
// on API calls even if it is served from a different origin than the API; on
// plain-HTTP localhost, None is invalid without Secure, so Lax is used (which
// is fine there because the dev server and API share an origin via the proxy).
func (s *Service) sameSite() http.SameSite {
	if s.SecureCookies {
		return http.SameSiteNoneMode
	}
	return http.SameSiteLaxMode
}

// logout ends the session.
//
// @Summary     Sign out
// @Description End the current session and clear the session cookie.
// @Tags        Platform
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Security    CookieSession
// @Router      /api/auth/logout [post]
func (s *Service) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(SessionCookie); err == nil && c.Value != "" && s.Enabled() {
		if u, ok := UserFrom(r.Context()); ok {
			_ = s.Store.Audit(r.Context(), store.Event{
				Login: u.Login, Action: "Signed out", Detail: "POST /api/auth/logout",
			})
		}
		_ = s.Store.DeleteSession(r.Context(), c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: SessionCookie, Value: "", Path: "/", MaxAge: -1})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// exchange trades the OAuth code for an access token. redirectURI must match
// the value sent at authorize.
func (s *Service) exchange(ctx context.Context, code, redirectURI string) (string, error) {
	form := url.Values{
		"client_id":     {s.ClientID},
		"client_secret": {s.ClientSecret},
		"code":          {code},
	}
	if redirectURI != "" {
		form.Set("redirect_uri", redirectURI)
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
