package api

// Instance registry endpoints. Creating or retiring an instance is a
// STRUCTURAL change: it stages into the draft change request and, on submit,
// the CR branch carries the scaffolded folder (per the repository's layout
// convention) plus the registry entry — reviewable like any other change.
// Metadata-only updates (version, region, labels, archive) commit directly
// with attribution, like parameter metadata.

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

// addInstance stages a new deployment target (optionally cloned from an
// existing one) into the draft change request. Nothing touches Git until the
// draft is submitted: the branch then carries the scaffolded folder plus the
// registry entry, reviewable like any other change.
func (s *Server) addInstance(w http.ResponseWriter, r *http.Request) {
	var req instanceReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	name := slugify(req.Name)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a valid instance name is required"})
		return
	}
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, exists := p.InstanceByName(name); exists {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "instance " + name + " already exists"})
		return
	}
	if req.CloneFrom != "" {
		if _, ok := p.InstanceByName(req.CloneFrom); !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "clone source " + req.CloneFrom + " not found"})
			return
		}
	}

	meta := model.Instance{
		Name: name, Environment: str(req.Environment), Region: str(req.Region),
		Zone: str(req.Zone), Site: str(req.Site), SoftwareVersion: str(req.SoftwareVersion),
		Status: str(req.Status), Labels: derefLabels(req.Labels),
	}
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

// updateInstance patches an instance's metadata or status (archive = status
// "archived").
func (s *Server) updateInstance(w http.ResponseWriter, r *http.Request) {
	var req instanceReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	inst, err := writer.UpdateInstance(s.RepoPath, r.PathValue("name"), req.patch())
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	s.commitCatalogChange(w, "Update instance "+inst.Name, author(r, req.Author), inst)
}

// deleteInstance stages the retirement of an instance (registry entry +
// folder) into the draft change request, reviewable before anything happens.
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
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "instance " + name + " not found"})
		return
	}
	s.stageStructural(w, author(r, req.Author), change.Item{
		Instance: name,
		Action:   change.ActionRemoveInstance,
	})
}
