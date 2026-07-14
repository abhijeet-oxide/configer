package api

// Shared plumbing: the catalog-commit helper, JSON response writers, CORS,
// and small string utilities used across the resource handlers.

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/auth"
)

// author resolves who is making a change: the authenticated session user
// always wins (never trust a body field when login is enabled); the request
// body's author is the single-user-mode fallback.
func author(r *http.Request, fallback string) string {
	if u, ok := auth.UserFrom(r.Context()); ok {
		if u.Name != "" && u.Email != "" {
			return u.Name + " <" + u.Email + ">"
		}
		if u.Name != "" {
			return u.Name + " (" + u.Login + ")"
		}
		return u.Login
	}
	if fallback == "" {
		return "anonymous"
	}
	return fallback
}

// commitCatalogChange commits a .configer metadata operation (and any
// accompanying real-file edits, e.g. a retired parameter's keys) directly
// onto the working branch with attribution, then writes the response.
func (s *Server) commitCatalogChange(w http.ResponseWriter, title, author string, response any) {
	if author == "" {
		author = "anonymous"
	}
	msg := title + "\n\nChanged-by: " + author + "\n"
	if _, _, err := s.Backend.CommitWorking(context.Background(), msg); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func slugify(name string) string {
	s := strings.ToLower(name)
	s = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		default:
			return '-'
		}
	}, s)
	return strings.Trim(strings.Join(strings.FieldsFunc(s, func(r rune) bool { return r == '-' }), "-"), "-")
}

func formatForFile(file string) string {
	switch {
	case strings.HasSuffix(file, ".xml"):
		return "xml"
	case strings.HasSuffix(file, ".json"):
		return "json"
	default:
		return "yaml"
	}
}

func stringify(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
}

// withCORS emits CORS headers only for an explicitly allowed origin
// (CONFIGER_CORS_ORIGIN). The frontend is same-origin in every supported
// setup — nginx serves it beside the API in production and the Vite dev
// server proxies /api — so by default no cross-origin access exists, which
// is also what cookie sessions require.
func withCORS(next http.Handler) http.Handler {
	allowed := os.Getenv("CONFIGER_CORS_ORIGIN")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if allowed != "" && r.Header.Get("Origin") == allowed {
			w.Header().Set("Access-Control-Allow-Origin", allowed)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
