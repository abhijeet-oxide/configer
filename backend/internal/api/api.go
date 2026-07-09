// Package api exposes Configer's HTTP REST API. For the MVP it serves the grid
// directly from a Git working tree on disk; production would front this with
// the Postgres grid cache described in the design.
package api

import (
	"encoding/json"
	"net/http"
	"sync"

	"github.com/abhijeet-oxide/configer/backend/internal/diff"
	"github.com/abhijeet-oxide/configer/backend/internal/grid"
	"github.com/abhijeet-oxide/configer/backend/internal/ingest"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/parsers"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/render"
	"github.com/abhijeet-oxide/configer/backend/internal/transposers"
	"github.com/abhijeet-oxide/configer/backend/internal/validate"
	"github.com/abhijeet-oxide/configer/backend/internal/writer"
)

// Server holds request-scoped dependencies.
type Server struct {
	RepoPath string
	Registry *plugin.Registry
	writeMu  sync.Mutex // serializes writes to the working tree
}

// New builds a Server with the built-in plugins registered.
func New(repoPath string) *Server {
	reg := plugin.NewRegistry()
	parsers.Register(reg)
	transposers.Register(reg)
	return &Server{RepoPath: repoPath, Registry: reg}
}

// Routes returns the HTTP handler with all endpoints mounted.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("GET /api/plugins", s.plugins)
	mux.HandleFunc("GET /api/project", s.projectInfo)
	mux.HandleFunc("GET /api/grid", s.grid)
	mux.HandleFunc("GET /api/instances", s.instances)
	mux.HandleFunc("GET /api/parameters/{id}", s.parameter)
	mux.HandleFunc("GET /api/compare", s.compare)
	mux.HandleFunc("GET /api/render/{instance}", s.render)
	mux.HandleFunc("POST /api/scan", s.scan)
	mux.HandleFunc("GET /api/validation/presets", s.presets)
	mux.HandleFunc("PUT /api/values", s.setValue)
	mux.HandleFunc("PUT /api/parameters/{id}", s.updateParameter)
	return withCORS(mux)
}

func (s *Server) load() (*project.Project, error) { return project.Load(s.RepoPath) }

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) plugins(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Registry.Manifests())
}

func (s *Server) projectInfo(w http.ResponseWriter, _ *http.Request) {
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	g := grid.Build(p)
	writeJSON(w, http.StatusOK, map[string]any{
		"project":    g.Project,
		"instances":  g.Instances,
		"categories": g.Categories,
		"paramCount": len(g.Rows),
	})
}

func (s *Server) grid(w http.ResponseWriter, _ *http.Request) {
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, grid.Build(p))
}

func (s *Server) instances(w http.ResponseWriter, _ *http.Request) {
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p.Registry)
}

func (s *Server) parameter(w http.ResponseWriter, r *http.Request) {
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	id := r.PathValue("id")
	param, ok := p.ParamByID(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "parameter not found"})
		return
	}
	writeJSON(w, http.StatusOK, param)
}

func (s *Server) compare(w http.ResponseWriter, r *http.Request) {
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	left := r.URL.Query().Get("left")
	right := r.URL.Query().Get("right")
	res, err := diff.CompareInstances(p, left, right)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) render(w http.ResponseWriter, r *http.Request) {
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	files, err := render.Instance(p, r.PathValue("instance"), s.Registry)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"instance": r.PathValue("instance"), "files": files})
}

func (s *Server) scan(w http.ResponseWriter, _ *http.Request) {
	p, err := s.load()
	ignore := project.Ignore{}
	if err == nil {
		ignore = p.Ignore
	}
	res, err := ingest.Scan(s.RepoPath, s.Registry, ignore)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) presets(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, validate.Presets())
}

// setValue is the validated write path for a single grid cell: the value is
// coerced to the parameter's declared type, checked against all validation
// rules, and only then written into the instance's sparse overlay. Invalid
// values are rejected with 422 so the source of truth never holds bad data.
func (s *Server) setValue(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Instance string `json:"instance"`
		ParamID  string `json:"paramId"`
		Value    any    `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	param, found := p.ParamByID(req.ParamID)
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "parameter not found"})
		return
	}
	if _, found := p.InstanceByName(req.Instance); !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "instance not found"})
		return
	}

	coerced, err := validate.Coerce(param.Type, req.Value)
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}
	if vr := validate.Value(param, coerced); !vr.Valid {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": vr.Message})
		return
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := writer.SetValue(s.RepoPath, req.Instance, req.ParamID, coerced); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "value": coerced})
}

// updateParameter patches a parameter's data type and/or validation rules in
// the catalog (used by the rule editor in the UI).
func (s *Server) updateParameter(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Type       *model.ParamType  `json:"type,omitempty"`
		Validation *model.Validation `json:"validation,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Validation != nil && req.Validation.Preset != "" {
		if _, found := validate.PresetByID(req.Validation.Preset); !found {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "unknown preset rule"})
			return
		}
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	param, err := writer.UpdateParameter(s.RepoPath, r.PathValue("id"), writer.ParamPatch{
		Type:       req.Type,
		Validation: req.Validation,
	})
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, param)
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
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
