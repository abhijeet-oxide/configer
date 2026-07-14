package api

// Read endpoints: project info, the parameter×instance grid, instances,
// parameter detail and history, compare, render preview, scan, and the
// validation preset library.

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/abhijeet-oxide/configer/backend/internal/diff"
	"github.com/abhijeet-oxide/configer/backend/internal/grid"
	"github.com/abhijeet-oxide/configer/backend/internal/ingest"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/render"
	"github.com/abhijeet-oxide/configer/backend/internal/repobackend"
	"github.com/abhijeet-oxide/configer/backend/internal/resolver"
	"github.com/abhijeet-oxide/configer/backend/internal/validate"
)

func (s *Server) projectInfo(w http.ResponseWriter, _ *http.Request) {
	p, _, err := s.loadWithDraft()
	if err != nil {
		writeErr(w, err)
		return
	}
	g := grid.Build(p)
	branch := s.branch()
	writeJSON(w, http.StatusOK, map[string]any{
		"project":    g.Project,
		"instances":  g.Instances,
		"categories": g.Categories,
		"paramCount": len(g.Rows),
		"branch":     branch,
		"remote":     s.Backend.Origin(),
	})
}

func (s *Server) grid(w http.ResponseWriter, _ *http.Request) {
	p, draft, err := s.loadWithDraft()
	if err != nil {
		writeErr(w, err)
		return
	}
	g := grid.Build(p)
	if draft != nil {
		pending := map[string]map[string]bool{}
		globalPending := map[string]bool{}
		for _, it := range draft.Items {
			if it.Scope == "global" {
				globalPending[it.ParamID] = true
				continue
			}
			if pending[it.ParamID] == nil {
				pending[it.ParamID] = map[string]bool{}
			}
			pending[it.ParamID][it.Instance] = true
		}
		for i := range g.Rows {
			id := g.Rows[i].Param.ID
			for name, c := range g.Rows[i].Cells {
				if pending[id][name] {
					c.Pending = true
				}
				// A pending global edit shows on every cell that would take
				// it (i.e. not overridden at a more specific level).
				if globalPending[id] && (c.Source == model.ScopeGlobal || c.Source == model.ScopeDefault) {
					c.Pending = true
				}
				g.Rows[i].Cells[name] = c
			}
		}
	}
	writeJSON(w, http.StatusOK, g)
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
	param, ok := p.ParamByID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "parameter not found"})
		return
	}
	writeJSON(w, http.StatusOK, param)
}

func (s *Server) compare(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	left, right := q.Get("left"), q.Get("right")
	leftRef, rightRef := q.Get("leftRef"), q.Get("rightRef")

	// No refs: compare within the current project (includes pending edits).
	if leftRef == "" && rightRef == "" {
		p, _, err := s.loadWithDraft()
		if err != nil {
			writeErr(w, err)
			return
		}
		res, err := diff.CompareInstances(p, left, right)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
		return
	}

	// Cross-ref: materialize each side's ref and compare across the two.
	pL, cleanL, err := s.projectAtRef(leftRef)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "left ref: " + err.Error()})
		return
	}
	defer cleanL()
	pR, cleanR, err := s.projectAtRef(rightRef)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "right ref: " + err.Error()})
		return
	}
	defer cleanR()
	res, err := diff.CompareAcross(pL, left, pR, right)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// repoRefs lists the branches and tags available to compare/render against.
func (s *Server) repoRefs(w http.ResponseWriter, _ *http.Request) {
	branches, tags, err := s.Backend.ListRefs(context.Background())
	if err != nil {
		writeErr(w, err)
		return
	}
	current, _ := s.Backend.DefaultBranch(context.Background())
	writeJSON(w, http.StatusOK, map[string]any{"current": current, "branches": branches, "tags": tags})
}

// history returns the application's recent config-change commits (those that
// touched the canonical model under .configer/), newest first. This backs the
// app-level History tab.
func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	limit := 40
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n <= 200 {
		limit = n
	}
	commits, err := s.Backend.Log(context.Background(), ".configer", limit)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"commits": commits, "supported": s.Backend.Kind() == "local"})
}

// paramHistoryEntry is one point on a parameter's value timeline.
type paramHistoryEntry struct {
	repobackend.Commit
	Value   string `json:"value"`   // effective value at this commit
	Present bool   `json:"present"` // whether the parameter existed then
	Changed bool   `json:"changed"` // value differs from the next-older commit
}

// valueString renders a resolved value for the history timeline: strings as-is,
// everything else as compact JSON so lists/numbers/bools are unambiguous.
func valueString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		return string(b)
	}
}

// parameterHistory walks recent config commits and resolves one parameter's
// effective value at each, so the inspector can show how a value changed over
// time (VS-Code / GitHub git-graph style). An optional ?instance= resolves the
// value for that instance; otherwise the catalog default (base value) is used.
func (s *Server) parameterHistory(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	instance := r.URL.Query().Get("instance")
	limit := 12
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n <= 40 {
		limit = n
	}
	commits, err := s.Backend.Log(context.Background(), ".configer", limit)
	if err != nil {
		writeErr(w, err)
		return
	}

	// Resolve the parameter's value in one materialized project.
	resolveAt := func(p *project.Project) (string, bool) {
		var param *model.Parameter
		for i := range p.Catalog.Parameters {
			if p.Catalog.Parameters[i].ID == id {
				param = &p.Catalog.Parameters[i]
				break
			}
		}
		if param == nil {
			return "", false
		}
		if instance != "" {
			for _, inst := range p.Registry.Instances {
				if inst.Name == instance {
					res := (&resolver.Resolver{Scopes: p.Scopes, Instance: p.Overlays}).Resolve(*param, inst)
					return valueString(res.Value), true
				}
			}
		}
		return valueString(param.Default), true
	}

	entries := make([]paramHistoryEntry, 0, len(commits))
	for _, c := range commits {
		p, cleanup, perr := s.projectAtRef(c.SHA)
		if perr != nil {
			// A commit we cannot materialize (shallow/gone) is skipped rather
			// than failing the whole timeline.
			continue
		}
		val, present := resolveAt(p)
		cleanup()
		entries = append(entries, paramHistoryEntry{Commit: c, Value: val, Present: present})
	}
	// Mark where the value actually changed (compared to the next-older entry).
	for i := range entries {
		older := i + 1
		if older >= len(entries) {
			entries[i].Changed = entries[i].Present // oldest known point: changed if it exists
			continue
		}
		entries[i].Changed = entries[i].Value != entries[older].Value || entries[i].Present != entries[older].Present
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"parameter": id,
		"instance":  instance,
		"entries":   entries,
		"supported": s.Backend.Kind() == "local",
	})
}

func (s *Server) render(w http.ResponseWriter, r *http.Request) {
	// ?ref renders a specific git ref (branch/tag/commit). Otherwise ?draft=false
	// renders the committed state (the baseline for the live diff) and the default
	// applies the current draft, so the preview shows exactly what a publish would
	// write, including unpublished edits.
	var p *project.Project
	var err error
	q := r.URL.Query()
	if ref := q.Get("ref"); ref != "" {
		var cleanup func()
		p, cleanup, err = s.projectAtRef(ref)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		defer cleanup()
	} else if q.Get("draft") == "false" {
		p, err = s.load()
	} else {
		p, _, err = s.loadWithDraft()
	}
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
