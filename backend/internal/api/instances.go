package api

// Instance registry endpoints. Instances are structural metadata (like the
// catalog): add/edit/archive/delete commit directly onto the working branch
// with attribution, so a new instance appears as a grid column immediately.

import (
	"encoding/json"
	"net/http"

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

// addInstance creates a new deployment target (or clones an existing one).
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

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	if req.CloneFrom != "" {
		inst, err := writer.CloneInstance(s.RepoPath, req.CloneFrom, name, req.patch())
		if err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		s.commitCatalogChange(w, "Add instance "+name+" (clone of "+req.CloneFrom+")", req.Author, inst)
		return
	}

	inst := model.Instance{
		Name: name, Environment: str(req.Environment), Region: str(req.Region),
		Zone: str(req.Zone), Site: str(req.Site), SoftwareVersion: str(req.SoftwareVersion),
		Status: str(req.Status), Labels: derefLabels(req.Labels),
	}
	if err := writer.AddInstance(s.RepoPath, inst); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	s.commitCatalogChange(w, "Add instance "+name, req.Author, inst)
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
	s.commitCatalogChange(w, "Update instance "+inst.Name, req.Author, inst)
}

// deleteInstance removes an instance from the registry and deletes its folder.
func (s *Server) deleteInstance(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Author string `json:"author"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	name := r.PathValue("name")

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := writer.DeleteInstance(s.RepoPath, name); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	s.commitCatalogChange(w, "Remove instance "+name, req.Author, map[string]any{"ok": true, "removed": name})
}
