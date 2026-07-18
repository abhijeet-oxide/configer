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
	"github.com/abhijeet-oxide/configer/backend/internal/repobackend"
)

// actorHolder is a per-request slot the author() helper fills with the
// resolved actor, so the audit trail (which runs after the handler, without
// the request body) records WHO acted instead of "anonymous". The hub
// installs the holder into the request context before dispatch; because the
// dispatched request shares that context, the handler's author() call and the
// post-dispatch audit see the same holder.
type actorHolder struct{ name string }

type actorKeyT struct{}

var actorKey actorKeyT

func withActorHolder(ctx context.Context) (context.Context, *actorHolder) {
	h := &actorHolder{}
	return context.WithValue(ctx, actorKey, h), h
}

// author resolves who is making a change: the authenticated session user
// always wins (never trust a body field when login is enabled); the request
// body's author is the single-user-mode fallback. The resolved actor is also
// recorded into the request's audit holder when one is installed.
func author(r *http.Request, fallback string) string {
	a := resolveAuthor(r, fallback)
	if h, ok := r.Context().Value(actorKey).(*actorHolder); ok && h.name == "" {
		h.name = a
	}
	return a
}

func resolveAuthor(r *http.Request, fallback string) string {
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

// identity resolves the git author for a UI-made commit: the authenticated
// session user (the identity behind the Git approval) with their real email,
// falling back to a GitHub noreply address for OAuth users without a public
// email. In single-user mode the request body's author string becomes the
// author with a clearly synthetic address; an unknown user leaves the zero
// Author, keeping the machine identity as author.
func identity(r *http.Request, fallback string) repobackend.Author {
	if u, ok := auth.UserFrom(r.Context()); ok {
		name := u.Name
		if name == "" {
			name = u.Login
		}
		email := u.Email
		if email == "" {
			email = u.Login + "@users.noreply.github.com"
		}
		return repobackend.Author{Name: name, Email: email}
	}
	if fallback == "" || fallback == "anonymous" {
		return repobackend.Author{}
	}
	return repobackend.Author{Name: fallback, Email: slugify(fallback) + "@users.noreply.configer.local"}
}

// bot is the machine identity (committer) used for co-author credit.
func bot() repobackend.Author {
	return repobackend.Author{
		Name:  getenv("CONFIGER_GIT_NAME", "Configer Bot"),
		Email: getenv("CONFIGER_GIT_EMAIL", "configer-bot@localhost"),
	}
}

// commitCatalogChange commits a .configer metadata operation (and any
// accompanying real-file edits, e.g. a retired parameter's keys) directly
// onto the working branch, then writes the response. The session user is the
// git author (Changed-by trailer as before); the machine identity commits
// and takes co-author credit.
func (s *Server) commitCatalogChange(w http.ResponseWriter, r *http.Request, title, authorFallback string, response any) {
	who := author(r, authorFallback)
	if who == "" {
		who = "anonymous"
	}
	ident := identity(r, authorFallback)
	msg := title + "\n\nChanged-by: " + who + "\n"
	if !ident.Empty() {
		msg += "Co-authored-by: " + bot().Sig() + "\n"
	}
	if _, _, err := s.Backend.CommitWorking(context.Background(), msg, ident); err != nil {
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

// writeErr answers with an unclassified 500. It is the catch-all for
// unexpected faults; handlers that know the failure class should prefer
// writeError with an explicit status + code. The X-Request-ID response header
// carries the correlation id here (the body form has no request in scope).
func writeErr(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusInternalServerError, APIError{Error: err.Error(), Code: CodeInternalError})
}

// withCORS emits CORS headers only for an explicitly allowed origin
// (CONFIGER_CORS_ORIGIN). The frontend is same-origin in every supported
// setup - nginx serves it beside the API in production and the Vite dev
// server proxies /api - so by default no cross-origin access exists, which
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
