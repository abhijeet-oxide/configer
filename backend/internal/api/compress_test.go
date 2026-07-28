package api

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// handler returning a body of n 'x' bytes with the given content type.
func bodyHandler(ct string, n int, status int) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", ct)
		if status != 0 {
			w.WriteHeader(status)
		}
		_, _ = w.Write([]byte(strings.Repeat("x", n)))
	})
}

func do(t *testing.T, h http.Handler, acceptEncoding string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/anything", nil)
	if acceptEncoding != "" {
		req.Header.Set("Accept-Encoding", acceptEncoding)
	}
	rec := httptest.NewRecorder()
	withCompression(h).ServeHTTP(rec, req)
	return rec
}

func TestCompressionGzipsLargeJSON(t *testing.T) {
	rec := do(t, bodyHandler("application/json", 200_000, 0), "gzip")
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if !strings.Contains(rec.Header().Get("Vary"), "Accept-Encoding") {
		t.Errorf("a response that varies by Accept-Encoding must say so: Vary = %q", rec.Header().Get("Vary"))
	}
	if rec.Body.Len() >= 200_000 {
		t.Errorf("body was not compressed: %d bytes", rec.Body.Len())
	}
	// It has to survive the round trip byte for byte.
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gzip read: %v", err)
	}
	if len(out) != 200_000 || strings.Trim(string(out), "x") != "" {
		t.Fatalf("round trip lost the body: %d bytes", len(out))
	}
}

func TestCompressionSkipped(t *testing.T) {
	cases := []struct {
		name, accept, ctype string
		size                int
	}{
		{"client did not ask", "", "application/json", 200_000},
		{"client refused gzip", "gzip;q=0", "application/json", 200_000},
		{"body below the threshold", "gzip", "application/json", 100},
		{"already-compressed type", "gzip", "application/octet-stream", 200_000},
		{"image", "gzip", "image/png", 200_000},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := do(t, bodyHandler(c.ctype, c.size, 0), c.accept)
			if got := rec.Header().Get("Content-Encoding"); got != "" {
				t.Errorf("Content-Encoding = %q, want none", got)
			}
			if rec.Body.Len() != c.size {
				t.Errorf("body = %d bytes, want %d verbatim", rec.Body.Len(), c.size)
			}
		})
	}
}

// A body-less response must keep its status and gain no encoding header.
func TestCompressionPreservesStatus(t *testing.T) {
	for _, status := range []int{http.StatusNotModified, http.StatusNoContent, http.StatusNotFound} {
		rec := do(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
		}), "gzip")
		if rec.Code != status {
			t.Errorf("status = %d, want %d", rec.Code, status)
		}
		if got := rec.Header().Get("Content-Encoding"); got != "" {
			t.Errorf("status %d: Content-Encoding = %q, want none", status, got)
		}
	}
}

// A handler that encoded its own body keeps ownership of the encoding.
func TestCompressionLeavesPreEncodedBodyAlone(t *testing.T) {
	rec := do(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "br")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(strings.Repeat("x", 200_000)))
	}), "gzip")
	if got := rec.Header().Get("Content-Encoding"); got != "br" {
		t.Fatalf("Content-Encoding = %q, want br untouched", got)
	}
	if rec.Body.Len() != 200_000 {
		t.Fatalf("body = %d bytes, want it passed through", rec.Body.Len())
	}
}
