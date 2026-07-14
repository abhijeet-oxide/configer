package api

import (
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
		rec := &statusRecorder{ResponseWriter: w}

		defer func() {
			if v := recover(); v != nil {
				if rec.status == 0 {
					writeJSON(rec, http.StatusInternalServerError,
						map[string]string{"error": "internal server error"})
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
				slog.String("request_id", rid),
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
