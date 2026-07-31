package api

// Bringing configuration INTO the catalog: analyzing a pasted blob, promoting
// scanned candidates, and retiring what a file no longer holds. What arrived on
// Git and needs deciding about is findings.go; this is what happens once the
// user has decided.

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/writer"
)

// analyzeImport extracts candidate parameters from a pasted configuration blob
// (not a repository file), so settings can be brought in incrementally without
// re-onboarding. The proposed candidates feed the same selection UI and the
// same POST /api/import commit path as a repository scan.
//
// @Summary     Analyze pasted configuration
// @Description Parse a pasted YAML/JSON/XML blob and propose candidate parameters (name, path, inferred type, sample value), each flagged if it is already managed. `file` names the repository path this content represents (for format detection and as the binding target); it defaults to a .yaml hint. Read-only: nothing is written. Select candidates and POST them to /api/import to commit.
// @Tags        Import & reconcile
// @Accept      json
// @Produce     json
// @Param       body body object true "{content: string, file?: string}"
// @Success     200 {object} map[string]interface{}
// @Failure     400 {object} APIError "Empty content or unrecognized format"
// @Router      /api/import/analyze [post]
func (s *Server) analyzeImport(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Content string `json:"content"`
		File    string `json:"file"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Content) == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "paste some configuration to analyze")
		return
	}
	file := strings.TrimSpace(req.File)
	if file == "" {
		file = "pasted.yaml" // a sensible default so YAML detection engages
	}
	content := []byte(req.Content)
	parser, err := s.Registry.ParserFor(file, content)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest,
			"could not recognize the format; name the file (e.g. values.yaml, config.json, app.xml) so the right parser is used")
		return
	}
	cands, err := parser.Extract(file, content)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "could not parse the pasted content: "+err.Error())
		return
	}

	// Flag candidates already managed at the same file+path so the UI can
	// pre-deselect them (importing a duplicate is skipped anyway).
	managed := map[string]bool{}
	if p, lerr := s.load(); lerr == nil {
		for _, param := range p.Catalog.Parameters {
			for _, b := range param.Bindings {
				managed[b.File+"|"+b.Path] = true
			}
		}
	}
	type analyzed struct {
		plugin.Candidate
		Managed bool `json:"managed"`
	}
	out := make([]analyzed, 0, len(cands))
	for _, c := range cands {
		out = append(out, analyzed{Candidate: c, Managed: managed[c.File+"|"+c.Path]})
	}
	writeJSON(w, http.StatusOK, map[string]any{"file": file, "count": len(out), "candidates": out})
}

// importParameters promotes scanned candidates into the catalog in one
// attributed commit (the import wizard's final step). Already-managed or
// conflicting entries are skipped and reported, never fatal.
//
// @Summary     Import scanned parameters
// @Description Promote scanned candidate parameters into the catalog in one attributed commit (the import wizard's final step). Already-managed or conflicting entries are skipped and reported, never fatal.
// @Tags        Import & reconcile
// @Accept      json
// @Produce     json
// @Param       body body object true "{parameters: Parameter[], ignoreFiles?: string[]}"
// @Success     200 {object} map[string]interface{}
// @Failure     400 {object} APIError "Malformed body or nothing selected"
// @Security    CookieSession
// @Router      /api/import [post]
func (s *Server) importParameters(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Parameters  []model.Parameter `json:"parameters"`
		IgnoreFiles []string          `json:"ignoreFiles"`
		Author      string            `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
		return
	}
	if len(req.Parameters) == 0 && len(req.IgnoreFiles) == 0 {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "nothing selected to import")
		return
	}

	s.treeMu.Lock()
	defer s.treeMu.Unlock()

	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}

	// Template-ize bindings (a file inside an instance folder becomes a
	// {folder}/… instance-layer binding) and collapse candidates that describe
	// the same value in multiple locations into one multi-binding parameter.
	for i := range req.Parameters {
		req.Parameters[i].Bindings = templateBindings(req.Parameters[i].Bindings, p.Registry.Instances)
	}
	req.Parameters = mergeBindings(req.Parameters)

	imported := 0
	var skipped []string
	for _, pm := range req.Parameters {
		if pm.Name == "" || len(pm.Bindings) == 0 || pm.Bindings[0].File == "" || pm.Bindings[0].Path == "" {
			skipped = append(skipped, pm.Name+" (incomplete)")
			continue
		}
		if pm.ID == "" {
			pm.ID = slugify(pm.Name)
		}
		if pm.Type == "" {
			pm.Type = model.TypeString
		}
		if pm.Scope == "" {
			pm.Scope = model.ScopeInstance
			if len(pm.BindingsOn(model.LayerInstance, model.Instance{Name: "-"})) == 0 {
				pm.Scope = model.ScopeGlobal // only shared bindings: edits apply to all
			}
		}
		if pm.Category == "" {
			pm.Category = "Uncategorized"
		}
		for i := range pm.Bindings {
			if pm.Bindings[i].Format == "" {
				pm.Bindings[i].Format = formatForFile(pm.Bindings[i].File)
			}
		}
		if err := writer.AddParameter(s.RepoPath, pm); err != nil {
			skipped = append(skipped, pm.Name)
			continue
		}
		imported++
	}
	if len(req.IgnoreFiles) > 0 {
		if err := writer.AddIgnoreFiles(s.RepoPath, req.IgnoreFiles); err != nil {
			writeErr(w, err)
			return
		}
	}

	title := "Import configuration"
	if imported > 0 {
		title = "Import " + itoa(imported) + " parameter(s) into the catalog"
	}
	s.commitCatalogChange(w, r, title, req.Author, map[string]any{
		"ok": true, "imported": imported, "skipped": skipped, "ignored": len(req.IgnoreFiles),
	})
}

// templateBindings rewrites concrete files that live inside a registered
// instance's folder into {folder}/… templates, so ONE binding covers every
// instance (the write-back dedup foundation). Files outside every instance
// folder stay literal (shared, base layer).
func templateBindings(bindings []model.Binding, instances []model.Instance) []model.Binding {
	out := make([]model.Binding, 0, len(bindings))
	seen := map[string]bool{}
	for _, b := range bindings {
		for _, inst := range instances {
			prefix := inst.FolderOrDefault() + "/"
			if strings.HasPrefix(b.File, prefix) {
				b.File = "{folder}/" + strings.TrimPrefix(b.File, prefix)
				break
			}
		}
		key := b.File + "|" + b.Path
		if !seen[key] {
			seen[key] = true
			out = append(out, b)
		}
	}
	return out
}

// mergeBindings collapses imported candidates that describe the SAME logical
// parameter appearing in multiple locations (same name AND same value) into
// one parameter with multiple bindings, so a single edit writes back into
// every location. Same-named candidates with DIFFERENT values are left
// separate (a genuine conflict, handled as before by the add step).
func mergeBindings(params []model.Parameter) []model.Parameter {
	type key struct{ name, val string }
	index := map[key]int{} // key -> position in out
	var out []model.Parameter
	for _, pm := range params {
		if pm.Name == "" || len(pm.Bindings) == 0 {
			out = append(out, pm)
			continue
		}
		k := key{name: pm.Name, val: valueString(pm.Default)}
		if i, ok := index[k]; ok {
			exist := &out[i]
			for _, nb := range pm.Bindings {
				dup := false
				for _, eb := range exist.Bindings {
					if eb.File == nb.File && eb.Path == nb.Path {
						dup = true
						break
					}
				}
				if !dup {
					if nb.Format == "" {
						nb.Format = formatForFile(nb.File)
					}
					exist.Bindings = append(exist.Bindings, nb)
				}
			}
			continue
		}
		index[k] = len(out)
		out = append(out, pm)
	}
	return out
}

// retireFile retires every parameter sourced from one (typically deleted)
// file: the one-click resolution for a file_deleted finding.
//
// @Summary     Retire parameters from a file
// @Description Retire every parameter sourced from one (typically deleted) file: the one-click resolution for a file_deleted finding.
// @Tags        Grid & parameters
// @Accept      json
// @Produce     json
// @Param       body body object true "{file: string}"
// @Success     200 {object} map[string]interface{}
// @Failure     400 {object} APIError "file is required"
// @Failure     404 {object} APIError "No parameters are sourced from that file"
// @Security    CookieSession
// @Router      /api/parameters/retire-file [post]
func (s *Server) retireFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		File   string `json:"file"`
		Author string `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.File == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "file is required")
		return
	}
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	var ids []string
	for _, param := range p.Catalog.Parameters {
		for _, b := range param.Bindings {
			concrete := b.File == req.File
			if !concrete && b.EffectiveLayer() == model.LayerInstance {
				for _, inst := range p.Registry.Instances {
					if b.ForInstance(inst).File == req.File {
						concrete = true
						break
					}
				}
			}
			if concrete {
				ids = append(ids, param.ID)
				break
			}
		}
	}
	if len(ids) == 0 {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "no parameters are sourced from that file")
		return
	}

	s.treeMu.Lock()
	defer s.treeMu.Unlock()
	for _, id := range ids {
		if err := writer.DeleteParameter(s.RepoPath, id, p.Registry.Instances); err != nil {
			writeErr(w, err)
			return
		}
	}
	s.commitCatalogChange(w, r, "Retire "+itoa(len(ids))+" parameter(s) from removed file "+req.File, req.Author,
		map[string]any{"ok": true, "retired": ids})
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
