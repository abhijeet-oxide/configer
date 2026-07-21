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

func TestSameSite(t *testing.T) {
	if (&Service{SecureCookies: true}).sameSite() != http.SameSiteNoneMode {
		t.Error("secure deployment should use SameSite=None so the SPA carries the session cross-origin")
	}
	if (&Service{SecureCookies: false}).sameSite() != http.SameSiteLaxMode {
		t.Error("plain-http dev should use SameSite=Lax (None needs Secure)")
	}
}
