package api

// Shared plumbing: the catalog-commit helper, JSON response writers, CORS,
// and small string utilities used across the resource handlers.

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/render"
)

// commitCatalogChange regenerates every instance's generated/ files, commits
// the catalog operation with attribution, pushes, and writes the response.
func (s *Server) commitCatalogChange(w http.ResponseWriter, title, author string, response any) {
	if author == "" {
		author = "anonymous"
	}
	if p, err := s.load(); err == nil {
		for _, inst := range p.Registry.Instances {
			files, rerr := render.Instance(p, inst.Name, s.Registry)
			if rerr != nil {
				continue // a broken instance must not block the catalog op
			}
			for _, f := range files {
				out := filepath.Join(s.RepoPath, "generated", inst.Name, f.Path)
				if err := os.MkdirAll(filepath.Dir(out), 0o755); err == nil {
					_ = os.WriteFile(out, []byte(f.Content), 0o644)
				}
			}
		}
	}
	// Catalog metadata is committed directly onto the working branch, with
	// attribution (a working-tree commit locally, a Git-data-API partial
	// commit remotely).
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

// withCORS allows the Vite dev server (different port) to call the API.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
