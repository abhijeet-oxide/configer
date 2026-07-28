package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCallbackURL(t *testing.T) {
	// An explicit callback always wins.
	s := &Service{CallbackURL: "https://cfg.example.com/api/auth/callback"}
	if got := s.callbackURL(httptest.NewRequest(http.MethodGet, "http://x/api/auth/login", nil)); got != "https://cfg.example.com/api/auth/callback" {
		t.Errorf("explicit callback: got %q", got)
	}

	// Derived from the request host when unset.
	s2 := &Service{}
	r := httptest.NewRequest(http.MethodGet, "http://configer.local:8080/api/auth/login", nil)
	if got := s2.callbackURL(r); got != "http://configer.local:8080/api/auth/callback" {
		t.Errorf("derived callback: got %q", got)
	}

	// Proxy headers win, so it stays correct behind TLS termination.
	r2 := httptest.NewRequest(http.MethodGet, "http://internal:8080/api/auth/login", nil)
	r2.Header.Set("X-Forwarded-Proto", "https")
	r2.Header.Set("X-Forwarded-Host", "configer.example.com")
	if got := s2.callbackURL(r2); got != "https://configer.example.com/api/auth/callback" {
		t.Errorf("proxied callback: got %q", got)
	}
}

func TestSafeReturn(t *testing.T) {
	cases := map[string]string{
		"/applications":        "/applications",
		"/application/x?a=1":   "/application/x?a=1",
		"":                     "/",
		"//evil.com":           "/",
		"https://evil.com":     "/",
		"http://evil.com/path": "/",
		"javascript:alert(1)":  "/",
	}
	for in, want := range cases {
		if got := safeReturn(in); got != want {
			t.Errorf("safeReturn(%q) = %q, want %q", in, got, want)
		}
	}
}

// The post-login redirect has to land on the page the user came from, on the
// address that actually serves the app - the API's own address usually serves
// no page at all, which is what turns a successful login into a "not found".
func TestReturnTarget(t *testing.T) {
	// Dev shape: the app runs on one loopback port, the API on another (the dev
	// server proxies /api), so login must come back to the APP's port.
	s := &Service{}
	r := httptest.NewRequest(http.MethodGet, "http://localhost:8080/api/auth/login", nil)
	r.Header.Set("Referer", "http://localhost:5173/applications")
	if got := s.returnTarget(r, "/applications"); got != "http://localhost:5173/applications" {
		t.Errorf("dev return: got %q", got)
	}
	// No return_to at all: the page that started the login is remembered.
	if got := s.returnTarget(r, ""); got != "http://localhost:5173/applications" {
		t.Errorf("referer return: got %q", got)
	}

	// Same-origin deployment (one address serves app and API).
	r2 := httptest.NewRequest(http.MethodGet, "http://configer.example.com/api/auth/login", nil)
	r2.Header.Set("Referer", "http://configer.example.com/inbox")
	if got := s.returnTarget(r2, "/inbox"); got != "http://configer.example.com/inbox" {
		t.Errorf("same-origin return: got %q", got)
	}

	// An untrusted origin must never receive the redirect.
	r3 := httptest.NewRequest(http.MethodGet, "https://configer.example.com/api/auth/login", nil)
	r3.Header.Set("Referer", "https://evil.example/steal")
	if got := s.returnTarget(r3, "https://evil.example/steal"); got != "https://configer.example.com/" {
		t.Errorf("open redirect not blocked: got %q", got)
	}
	if got := s.returnTarget(r3, ""); got != "https://configer.example.com/" {
		t.Errorf("untrusted referer used: got %q", got)
	}

	// An explicitly configured app address wins over everything.
	s4 := &Service{AppURL: "https://ui.example.com"}
	r4 := httptest.NewRequest(http.MethodGet, "https://api.example.com/api/auth/login", nil)
	r4.Header.Set("Referer", "https://ui.example.com/applications")
	if got := s4.returnTarget(r4, "/applications"); got != "https://ui.example.com/applications" {
		t.Errorf("configured app url: got %q", got)
	}
	if got := s4.returnTarget(r4, "https://other.example.com/x"); got != "https://ui.example.com/" {
		t.Errorf("foreign absolute return: got %q", got)
	}
}

func TestSafeReturnSkipsAPI(t *testing.T) {
	// Coming back to a JSON endpoint after login shows the user raw JSON.
	if got := safeReturn("/api/auth/me"); got != "/" {
		t.Errorf("safeReturn(/api/auth/me) = %q, want /", got)
	}
}

func TestSameSite(t *testing.T) {
	if (&Service{SecureCookies: true}).sameSite() != http.SameSiteNoneMode {
		t.Error("secure deployment should use SameSite=None so the SPA carries the session cross-origin")
	}
	if (&Service{SecureCookies: false}).sameSite() != http.SameSiteLaxMode {
		t.Error("plain-http dev should use SameSite=Lax (None needs Secure)")
	}
}
