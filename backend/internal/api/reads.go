package api

// Read endpoints: project info, the parameter×instance grid, instances,
// parameter detail and history, compare, render preview, scan, and the
// validation preset library.

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strconv"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/diff"
	"github.com/abhijeet-oxide/configer/backend/internal/grid"
	"github.com/abhijeet-oxide/configer/backend/internal/ingest"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/repobackend"
	"github.com/abhijeet-oxide/configer/backend/internal/resolver"
	"github.com/abhijeet-oxide/configer/backend/internal/validate"
)

// projectInfo returns the project summary or an onboarding-needed marker.
//
// @Summary     Project summary
// @Description Project name, instances, category tree and parameter count, with the current draft applied. When the repository has no Configer application yet, returns `{initialized:false}` so the client routes to onboarding (still 200, not an error).
// @Tags        Grid & parameters
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Failure     500 {object} APIError
// @Router      /api/project [get]
func (s *Server) projectInfo(w http.ResponseWriter, _ *http.Request) {
	// A connected-but-uninitialized repository is a first-class state: the
	// UI routes it to onboarding instead of an error page.
	if !s.initialized() {
		writeJSON(w, http.StatusOK, map[string]any{
			"initialized": false,
			"project":     filepath.Base(s.RepoPath),
			"branch":      s.branch(),
			"remote":      s.Backend.Origin(),
		})
		return
	}
	p, draft, err := s.loadWithDraft()
	if err != nil {
		writeErr(w, err)
		return
	}
	g := grid.Build(p)
	if draft != nil {
		grid.ApplyDraft(&g, draft.Items)
	}
	branch := s.branch()
	writeJSON(w, http.StatusOK, map[string]any{
		"initialized": true,
		"project":     g.Project,
		"instances":   g.Instances,
		"categories":  g.Categories,
		"paramCount":  len(g.Rows),
		"branch":      branch,
		"remote":      s.Backend.Origin(),
	})
}

// grid returns the full parameter x instance matrix.
//
// @Summary     Parameter x instance grid
// @Description The full matrix: every parameter row x every instance column, each cell resolved from the real repository files with its provenance (default / base / instance), type, validation state and version state. The current draft's pending edits are previewed on top.
// @Tags        Grid & parameters
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Failure     500 {object} APIError
// @Router      /api/grid [get]
func (s *Server) grid(w http.ResponseWriter, _ *http.Request) {
	p, draft, err := s.loadWithDraft()
	if err != nil {
		writeErr(w, err)
		return
	}
	g := grid.Build(p)
	if draft != nil {
		grid.ApplyDraft(&g, draft.Items)
	}
	writeJSON(w, http.StatusOK, g)
}

// instances returns the instance registry.
//
// @Summary     List instances
// @Description The instance (deployment target) registry: metadata plus folder bindings for every instance.
// @Tags        Instances
// @Produce     json
// @Success     200 {object} model.InstanceRegistry
// @Failure     500 {object} APIError
// @Router      /api/instances [get]
func (s *Server) instances(w http.ResponseWriter, _ *http.Request) {
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p.Registry)
}

// parameter returns one parameter's metadata.
//
// @Summary     Get a parameter
// @Description Full metadata for one catalog parameter: type, scope, category, bindings, validation and version state.
// @Tags        Grid & parameters
// @Produce     json
// @Param       id path string true "Parameter id (slug)"
// @Success     200 {object} model.Parameter
// @Failure     404 {object} APIError
// @Failure     500 {object} APIError
// @Router      /api/parameters/{id} [get]
func (s *Server) parameter(w http.ResponseWriter, r *http.Request) {
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	param, ok := p.ParamByID(r.PathValue("id"))
	if !ok {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "parameter not found")
		return
	}
	writeJSON(w, http.StatusOK, param)
}

// compare returns a semantic parameter-level diff between two instances.
//
// @Summary     Compare two instances
// @Description Semantic, parameter-level diff between two instances. Without refs it compares the current project (pending edits included); with leftRef/rightRef it materializes each side at that git ref and compares across them.
// @Tags        Grid & parameters
// @Produce     json
// @Param       left     query string true  "Left instance name"
// @Param       right    query string true  "Right instance name"
// @Param       leftRef  query string false "Git ref (branch/tag/commit) for the left side"
// @Param       rightRef query string false "Git ref for the right side"
// @Success     200 {object} map[string]interface{}
// @Failure     400 {object} APIError
// @Failure     500 {object} APIError
// @Router      /api/compare [get]
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
//
// @Summary     List git refs
// @Description The branches and tags available to compare or render against, plus the current branch.
// @Tags        Grid & parameters
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Failure     500 {object} APIError
// @Router      /api/repo/refs [get]
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
//
// @Summary     Application change history
// @Description Recent commits that touched the canonical model under `.configer/`, newest first. `supported` is false on backends (remote no-clone) that cannot serve a log.
// @Tags        Grid & parameters
// @Produce     json
// @Param       limit query int false "Max commits (1-200, default 40)"
// @Success     200 {object} map[string]interface{}
// @Failure     500 {object} APIError
// @Router      /api/history [get]
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
// parameterHistory returns one parameter's value over recent commits.
//
// @Summary     Parameter value timeline
// @Description Resolves one parameter's effective value at each recent config commit, so the inspector can show how it changed over time. `?instance=` resolves for that instance; otherwise the catalog default is used.
// @Tags        Grid & parameters
// @Produce     json
// @Param       id       path  string true  "Parameter id (slug)"
// @Param       instance query string false "Resolve the value for this instance"
// @Param       limit    query int    false "Max commits (1-40, default 12)"
// @Success     200 {object} map[string]interface{}
// @Failure     500 {object} APIError
// @Router      /api/parameters/{id}/history [get]
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
					res := resolver.New(p.Root).Resolve(*param, inst)
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

// render returns an instance's real repository files.
//
// @Summary     Render an instance's files
// @Description The instance's REAL repository files (write-back-native: nothing is generated). By default the current draft is applied in memory so the preview shows exactly what a publish would write; `?draft=false` serves the committed working tree (the diff baseline); `?ref=` serves the files at a git ref.
// @Tags        Files
// @Produce     json
// @Param       instance path  string true  "Instance name"
// @Param       draft    query string false "false = committed content (diff baseline)" Enums(false)
// @Param       ref      query string false "Serve files at this git ref instead"
// @Success     200 {object} map[string]interface{}
// @Failure     400 {object} APIError
// @Failure     500 {object} APIError
// @Router      /api/render/{instance} [get]
func (s *Server) render(w http.ResponseWriter, r *http.Request) {
	// The instance's REAL repository files (write-back-native: nothing is
	// generated). ?ref serves them at a git ref; ?draft=false serves the
	// working tree as committed; the default applies the current draft
	// in memory, so the preview shows exactly what a publish would write.
	var p *project.Project
	var err error
	var draft *change.ChangeRequest
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
		p, draft, err = s.loadWithDraft()
	}
	if err != nil {
		writeErr(w, err)
		return
	}
	var items []change.Item
	if draft != nil {
		items = draft.Items
	}
	files, err := instanceFiles(p, r.PathValue("instance"), items)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"instance": r.PathValue("instance"), "files": files})
}

// scan detects files and extracts candidate parameters (read-only).
//
// @Summary     Scan for candidate settings
// @Description Read-only ingest scan: detect config files and extract candidate parameters. Nothing is written; use import to promote candidates.
// @Tags        Import & reconcile
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Failure     500 {object} APIError
// @Router      /api/scan [post]
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

// presets returns the predefined validation-rule library.
//
// @Summary     Validation presets
// @Description The predefined validation-rule library (port, cidr, ipv4, ...) available to attach to parameters.
// @Tags        Plugins & validation
// @Produce     json
// @Success     200 {array} object
// @Router      /api/validation/presets [get]
func (s *Server) presets(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, validate.Presets())
}
