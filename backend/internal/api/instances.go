package api

// Instance registry endpoints. Creating or retiring an instance is a
// STRUCTURAL change: it stages into the draft change request and, on submit,
// the CR branch carries the scaffolded folder (per the repository's layout
// convention) plus the registry entry - reviewable like any other change.
// Metadata-only updates (version, region, labels, archive) also stage into
// the draft, so every edit to an instance is a pending change on the feature
// branch, never a silent commit to the main branch.

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/writer"
)

type instanceReq struct {
	Name            string             `json:"name"`
	Environment     *string            `json:"environment,omitempty"`
	Region          *string            `json:"region,omitempty"`
	Zone            *string            `json:"zone,omitempty"`
	Site            *string            `json:"site,omitempty"`
	SoftwareVersion *string            `json:"softwareVersion,omitempty"`
	Status          *string            `json:"status,omitempty"`
	Labels          *map[string]string `json:"labels,omitempty"`
	CloneFrom       string             `json:"cloneFrom,omitempty"`
	Author          string             `json:"author,omitempty"`
}

func (r instanceReq) patch() writer.InstancePatch {
	return writer.InstancePatch{
		Environment: r.Environment, Region: r.Region, Zone: r.Zone, Site: r.Site,
		SoftwareVersion: r.SoftwareVersion, Status: r.Status, Labels: r.Labels,
	}
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func derefLabels(p *map[string]string) map[string]string {
	if p == nil {
		return nil
	}
	return *p
}

// addInstance stages the creation of a new deployment target as a PENDING
// structural change on the draft change request - it does NOT touch the main
// branch. On submit the CR branch carries the scaffolded folder (a real
// parallel copy of the clone source's managed files, per the repository's
// layout convention) plus the registry entry, reviewable like any other
// change. Until then the Files and Instances views preview the new folder as
// pending, and value edits made against it stage in the same draft.
//
// @Summary     Create an instance
// @Description Stage a new deployment target as a pending structural change on the draft (it does NOT touch the main branch). On submit the CR branch carries the scaffolded folder plus the registry entry. `cloneFrom` seeds the new folder from an existing instance.
// @Tags        Instances
// @Accept      json
// @Produce     json
// @Param       body body object true "Instance metadata (name required; optional cloneFrom)"
// @Success     200 {object} StagedResponse
// @Failure     400 {object} APIError "Malformed body or invalid name"
// @Failure     404 {object} APIError "Clone source not found"
// @Failure     409 {object} APIError "Name already exists (committed or pending)"
// @Security    CookieSession
// @Router      /api/instances [post]
func (s *Server) addInstance(w http.ResponseWriter, r *http.Request) {
	var req instanceReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
		return
	}
	name := slugify(req.Name)
	if name == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "a valid instance name is required")
		return
	}

	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, exists := p.InstanceByName(name); exists {
		writeError(w, r, http.StatusConflict, CodeConflict, "instance "+name+" already exists")
		return
	}
	// A pending add for the same name is also a conflict.
	if d := s.Store.CurrentDraft(); d != nil {
		for _, it := range d.Items {
			if it.Act() == change.ActionAddInstance && it.Instance == name {
				writeError(w, r, http.StatusConflict, CodeConflict, "instance "+name+" is already pending in your draft")
				return
			}
		}
	}

	meta := model.Instance{
		Name: name, Environment: str(req.Environment), Region: str(req.Region),
		Zone: str(req.Zone), Site: str(req.Site), SoftwareVersion: str(req.SoftwareVersion),
		Status: str(req.Status), Labels: derefLabels(req.Labels),
	}
	if meta.Status == "" {
		meta.Status = "active"
	}
	if req.CloneFrom != "" {
		from, ok := p.InstanceByName(req.CloneFrom)
		if !ok {
			writeError(w, r, http.StatusNotFound, CodeNotFound, "clone source "+req.CloneFrom+" not found")
			return
		}
		if meta.SoftwareVersion == "" {
			meta.SoftwareVersion = from.SoftwareVersion
		}
	}
	// New carries the metadata; Old carries the clone source name ("" = empty).
	s.stageStructural(w, author(r, req.Author), change.Item{
		Instance: name,
		Action:   change.ActionAddInstance,
		Old:      req.CloneFrom,
		New:      meta,
	})
}

// stageStructural puts a topology item into the draft change request.
func (s *Server) stageStructural(w http.ResponseWriter, author string, it change.Item) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if author == "" {
		author = "anonymous"
	}
	it.UpdatedAt = time.Now().UTC()
	draft, err := s.Store.Draft(author, s.branch())
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, err := s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
		cr.UpsertItem(it)
		return nil
	}); err != nil {
		writeErr(w, err)
		return
	}
	d := s.Store.CurrentDraft()
	pending := 0
	if d != nil {
		pending = len(d.Items)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "staged": true, "pending": pending, "changeId": draft.ID})
}

// updateInstance stages a metadata/status edit (archive = status "archived")
// as a PENDING change - never a direct commit to the main branch. If the
// instance is itself still pending (a draft add-instance), the edit folds
// into that add so submit produces a single clean registry entry.
// updateInstance stages a metadata/status edit into the draft.
//
// @Summary     Update an instance
// @Description Stage a metadata/status edit (archive = status "archived") as a pending change - never a direct commit to the main branch. If the instance is itself still a pending add, the edit folds into that add.
// @Tags        Instances
// @Accept      json
// @Produce     json
// @Param       name path string true "Instance name"
// @Param       body body object true "Partial instance metadata patch"
// @Success     200 {object} StagedResponse
// @Failure     400 {object} APIError "Malformed body"
// @Failure     404 {object} APIError "Unknown instance"
// @Security    CookieSession
// @Router      /api/instances/{name} [put]
func (s *Server) updateInstance(w http.ResponseWriter, r *http.Request) {
	var req instanceReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
		return
	}
	name := r.PathValue("name")
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	_, committed := p.InstanceByName(name)

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	// Folding into a pending add keeps the new instance one reviewable item.
	if d := s.Store.CurrentDraft(); d != nil {
		for _, it := range d.Items {
			if it.Act() == change.ActionAddInstance && it.Instance == name {
				meta := decodeInstance(it.New)
				writer.ApplyInstancePatch(&meta, req.patch())
				if _, uerr := s.Store.Update(d.ID, func(cr *change.ChangeRequest) error {
					cr.UpsertItem(change.Item{Instance: name, Action: change.ActionAddInstance, Old: it.Old, New: meta, UpdatedAt: time.Now().UTC()})
					return nil
				}); uerr != nil {
					writeErr(w, uerr)
					return
				}
				writeJSON(w, http.StatusOK, map[string]any{"ok": true, "staged": true, "instance": meta})
				return
			}
		}
	}
	if !committed {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "instance "+name+" not found")
		return
	}
	draft, err := s.Store.Draft(author(r, req.Author), s.branch())
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, err := s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
		cr.UpsertItem(change.Item{Instance: name, Action: change.ActionUpdateInstance, New: req.patch(), UpdatedAt: time.Now().UTC()})
		return nil
	}); err != nil {
		writeErr(w, err)
		return
	}
	d := s.Store.CurrentDraft()
	pending := 0
	if d != nil {
		pending = len(d.Items)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "staged": true, "pending": pending, "changeId": draft.ID})
}

// decodeInstance round-trips a JSON-shaped any (a stored draft item's New)
// back into a model.Instance.
func decodeInstance(v any) model.Instance {
	var m model.Instance
	b, _ := json.Marshal(v)
	_ = json.Unmarshal(b, &m)
	return m
}

// deleteInstance stages the retirement of an instance (registry entry +
// folder) into the draft change request, reviewable before anything happens.
// deleteInstance stages an instance's retirement into the draft.
//
// @Summary     Delete an instance
// @Description Stage the retirement of an instance (registry entry + folder) into the draft, reviewable before anything happens.
// @Tags        Instances
// @Produce     json
// @Param       name path string true "Instance name"
// @Success     200 {object} StagedResponse
// @Failure     404 {object} APIError "Unknown instance"
// @Security    CookieSession
// @Router      /api/instances/{name} [delete]
func (s *Server) deleteInstance(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Author string `json:"author"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	name := r.PathValue("name")

	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, ok := p.InstanceByName(name); !ok {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "instance "+name+" not found")
		return
	}
	s.stageStructural(w, author(r, req.Author), change.Item{
		Instance: name,
		Action:   change.ActionRemoveInstance,
	})
}
