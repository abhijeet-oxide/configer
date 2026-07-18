package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"
)

// This file adds the baseline HTTP observability every service needs: a request
// id on every response, one structured access-log line per request (method,
// path, status, duration), and a panic recovery net so a single bad handler
// never takes the process down. For traces/metrics, OpenTelemetry +
// Prometheus are the recommended next step.

// maxBodyBytes caps a request body so a single large POST cannot force
// unbounded memory allocation. It is generous enough for the biggest legitimate
// payload (a whole-file draft save or an import) yet small enough to stop abuse.
const maxBodyBytes = 10 << 20 // 10 MiB

// requestIDKeyT is the context key under which the per-request correlation id
// is stored so any handler (not just the access log) can attach it to its own
// logs and error responses.
type requestIDKeyT struct{}

var requestIDKey requestIDKeyT

// requestID returns the correlation id carried by the request context, or "".
func requestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

// withBodyLimit caps the request body on every mutating request. Reads carry no
// body worth bounding; writes go through http.MaxBytesReader, which makes a
// handler's Decode fail (and the server answer 413) past the cap.
func withBodyLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil && r.Method != http.MethodGet && r.Method != http.MethodHead {
			r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		}
		next.ServeHTTP(w, r)
	})
}

// statusRecorder captures the status code and byte count for logging.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += n
	return n, err
}

// newRequestID returns a short random hex id for correlating logs.
func newRequestID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "________________"
	}
	return hex.EncodeToString(b[:])
}

// withObservability wraps a handler with request-id, structured access logging,
// and panic recovery. It is the outermost middleware so it sees final statuses.
func withObservability(next http.Handler, log *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rid := r.Header.Get("X-Request-ID")
		if rid == "" {
			rid = newRequestID()
		}
		w.Header().Set("X-Request-ID", rid)
		// Thread the id through the context so downstream handlers and any log
		// they emit can correlate to this same request.
		r = r.WithContext(context.WithValue(r.Context(), requestIDKey, rid))
		rec := &statusRecorder{ResponseWriter: w}

		defer func() {
			if v := recover(); v != nil {
				if rec.status == 0 {
					writeJSON(rec, http.StatusInternalServerError,
						map[string]string{"error": "internal server error", "requestId": rid})
				}
				log.Error("panic recovered",
					slog.String("request_id", rid),
					slog.String("method", r.Method),
					slog.String("path", r.URL.Path),
					slog.Any("panic", v),
					slog.String("stack", string(debug.Stack())),
				)
			}
			// Health probes are noisy; log them at debug, everything else at info
			// (or warn/error for 4xx/5xx).
			level := slog.LevelInfo
			switch {
			case rec.status >= 500:
				level = slog.LevelError
			case rec.status >= 400:
				level = slog.LevelWarn
			case r.URL.Path == "/api/health" || r.URL.Path == "/api/healthz":
				level = slog.LevelDebug
			}
			log.LogAttrs(r.Context(), level, "http request",
				slog.String("request_id", requestID(r.Context())),
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", rec.status),
				slog.Int("bytes", rec.bytes),
				slog.Duration("duration", time.Since(start)),
			)
		}()

		next.ServeHTTP(rec, r)
	})
}
