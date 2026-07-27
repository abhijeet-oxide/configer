package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The local-folder source browses the SERVER's filesystem, so it may only be
// offered when the browser is on that same machine. Each of these cases is a
// deployment shape someone actually runs.
func TestLocalFoldersEnabled(t *testing.T) {
	cases := []struct {
		name        string
		remoteAddr  string
		headers     map[string]string
		environment string
		override    string
		want        bool
	}{
		{
			name:        "developer on their own machine",
			remoteAddr:  "127.0.0.1:54321",
			environment: "development",
			want:        true,
		},
		{
			name:        "developer on their own machine over IPv6",
			remoteAddr:  "[::1]:54321",
			environment: "development",
			want:        true,
		},
		{
			name:        "production deployment",
			remoteAddr:  "127.0.0.1:54321",
			environment: "production",
			want:        false,
		},
		{
			name:        "behind a reverse proxy: loopback peer is the proxy",
			remoteAddr:  "127.0.0.1:54321",
			headers:     map[string]string{"X-Forwarded-For": "203.0.113.7"},
			environment: "development",
			want:        false,
		},
		{
			name:        "remote browser",
			remoteAddr:  "203.0.113.7:54321",
			environment: "development",
			want:        false,
		},
		{
			name:        "explicitly forced on for a hosted workstation",
			remoteAddr:  "203.0.113.7:54321",
			environment: "production",
			override:    "true",
			want:        true,
		},
		{
			name:        "explicitly forced off locally",
			remoteAddr:  "127.0.0.1:54321",
			environment: "development",
			override:    "false",
			want:        false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.override != "" {
				t.Setenv("CONFIGER_LOCAL_FOLDERS", c.override)
			} else {
				t.Setenv("CONFIGER_LOCAL_FOLDERS", "")
			}
			r := httptest.NewRequest(http.MethodGet, "/api/fs/browse", nil)
			r.RemoteAddr = c.remoteAddr
			for k, v := range c.headers {
				r.Header.Set(k, v)
			}
			if got := localFoldersEnabled(r, c.environment); got != c.want {
				t.Errorf("localFoldersEnabled = %v, want %v", got, c.want)
			}
		})
	}
}

// Hiding the control in the UI must not be the only protection: the endpoint
// itself refuses on a hosted deployment.
func TestBrowseFoldersRefusedWhenHosted(t *testing.T) {
	h := stubHub(t, "http://unused")
	h.Environment = "production"
	t.Setenv("CONFIGER_LOCAL_FOLDERS", "")

	r := httptest.NewRequest(http.MethodGet, "/api/fs/browse", nil)
	r.RemoteAddr = "203.0.113.7:54321"
	rec := httptest.NewRecorder()
	h.browseFolders(rec, r)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}
