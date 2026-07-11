package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/repobackend"
	"github.com/abhijeet-oxide/configer/backend/internal/writer"
)

// Finding is one repository event Configer detected between the acknowledged
// commit and HEAD: the "everything can also happen directly on Git" surface:
// files added, changed, deleted or renamed, whole folders (possible new
// vendor versions) appearing, and upstream branches vanishing are all
// reported here instead of failing silently.
type Finding struct {
	Type string `json:"type"` // new_file | file_changed | file_deleted | file_renamed | new_folder
	Path string `json:"path"`
	// OldPath is set for renames.
	OldPath string `json:"oldPath,omitempty"`
	// Candidates counts extractable parameters in a new config file.
	Candidates int `json:"candidates,omitempty"`
	// Params lists managed parameter IDs affected by a change/deletion.
	Params []string `json:"params,omitempty"`
	// Detail is a human sentence describing what happened and what to do.
	Detail string `json:"detail"`
}

const ackKey = "reconcileAckSha"

// findings computes repository events between the acknowledged SHA and HEAD.
func (s *Server) findings(w http.ResponseWriter, r *http.Request) {
	head, err := s.Backend.HeadSHA(r.Context(), "HEAD")
	if err != nil {
		writeErr(w, err)
		return
	}
	ack := s.Store.GetMeta(ackKey)
	if ack == "" {
		// First run: everything up to now is the baseline, not news.
		_ = s.Store.SetMeta(ackKey, head)
		ack = head
	}
	var changes []repobackend.FileChange
	if ack != head {
		var derr error
		changes, derr = s.Backend.Diff(r.Context(), ack, head)
		if derr != nil {
			// The acknowledged commit may have been rewritten away
			// (force-push): re-baseline rather than erroring forever.
			_ = s.Store.SetMeta(ackKey, head)
			ack, changes = head, nil
		}
	}

	p, _ := s.load()
	managedBy := map[string][]string{} // file -> param IDs
	managedPath := map[string]bool{}   // "file|path" -> already in the catalog
	if p != nil {
		for _, param := range p.Catalog.Parameters {
			if param.Source.File == "" {
				continue // design-phase parameters have no file to watch
			}
			managedBy[param.Source.File] = append(managedBy[param.Source.File], param.ID)
			managedPath[param.Source.File+"|"+param.Source.Path] = true
		}
	}

	out := []Finding{}
	newDirs := map[string]int{}
	reportedGone := map[string]bool{}
	for _, c := range changes {
		path := filepath.ToSlash(c.Path)
		if strings.HasPrefix(path, ".configer/") || strings.HasPrefix(path, "generated/") {
			continue // Configer's own artifacts are not "external" news
		}
		switch c.Status {
		case "A":
			content, rerr := os.ReadFile(filepath.Join(s.RepoPath, path))
			if rerr != nil {
				continue
			}
			parser, perr := s.Registry.ParserFor(path, content)
			if perr != nil {
				continue // not a config file
			}
			cands, _ := parser.Extract(path, content)
			// Only candidates not yet in the catalog are news; once the user
			// imports them the finding resolves itself.
			fresh := 0
			for _, c := range cands {
				if !managedPath[path+"|"+c.Path] {
					fresh++
				}
			}
			if fresh == 0 {
				continue
			}
			out = append(out, Finding{
				Type:       "new_file",
				Path:       path,
				Candidates: fresh,
				Detail:     "A new configuration file appeared in the repository. You can import its parameters or ignore it.",
			})
			if dir := filepath.ToSlash(filepath.Dir(path)); dir != "." && dir != "base" {
				newDirs[strings.Split(dir, "/")[0]]++
			}
		case "M":
			if ids := managedBy[path]; len(ids) > 0 {
				out = append(out, Finding{
					Type:   "file_changed",
					Path:   path,
					Params: ids,
					Detail: "A managed file was changed directly on Git. The grid already shows the new values.",
				})
			}
		case "D":
			if ids := managedBy[path]; len(ids) > 0 {
				reportedGone[path] = true
				out = append(out, Finding{
					Type:   "file_deleted",
					Path:   path,
					Params: ids,
					Detail: "A file that parameters are sourced from was deleted on Git. Retire the affected parameters or restore the file.",
				})
			}
		case "R":
			old := filepath.ToSlash(c.OldPath)
			if ids := managedBy[old]; len(ids) > 0 {
				reportedGone[old] = true
				out = append(out, Finding{
					Type:    "file_renamed",
					Path:    path,
					OldPath: old,
					Params:  ids,
					Detail:  "A managed file was renamed on Git. Its parameters still point at the old path.",
				})
			}
		}
	}
	// Safety net beyond the diff: a managed source file can be missing even
	// when the ack..HEAD range never shows a "D" (added and deleted inside
	// one unacknowledged window, or gone since before the baseline).
	// Parameters pointing at a missing file always deserve a finding.
	for file, ids := range managedBy {
		if reportedGone[file] {
			continue
		}
		if _, statErr := os.Stat(filepath.Join(s.RepoPath, file)); os.IsNotExist(statErr) {
			out = append(out, Finding{
				Type:   "file_deleted",
				Path:   file,
				Params: ids,
				Detail: "A file that parameters are sourced from no longer exists in the repository. Retire the affected parameters or restore the file.",
			})
		}
	}

	for dir, n := range newDirs {
		if n >= 2 {
			out = append(out, Finding{
				Type:       "new_folder",
				Path:       dir + "/",
				Candidates: n,
				Detail:     "Several new configuration files appeared under one folder, possibly a new software version drop. Scan it to introduce or deprecate parameters.",
			})
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"baseSha": ack, "headSha": head, "findings": out})
}

// ackFindings marks everything up to HEAD as seen.
func (s *Server) ackFindings(w http.ResponseWriter, r *http.Request) {
	head, err := s.Backend.HeadSHA(r.Context(), "HEAD")
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := s.Store.SetMeta(ackKey, head); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ackSha": head})
}

// importParameters promotes scanned candidates into the catalog in one
// attributed commit (the import wizard's final step). Already-managed or
// conflicting entries are skipped and reported, never fatal.
func (s *Server) importParameters(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Parameters  []model.Parameter `json:"parameters"`
		IgnoreFiles []string          `json:"ignoreFiles"`
		Author      string            `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if len(req.Parameters) == 0 && len(req.IgnoreFiles) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "nothing selected to import"})
		return
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	imported := 0
	var skipped []string
	for _, pm := range req.Parameters {
		if pm.Name == "" || pm.Source.File == "" || pm.Source.Path == "" {
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
		}
		if pm.Category == "" {
			pm.Category = "Uncategorized"
		}
		if pm.Source.Format == "" {
			pm.Source.Format = formatForFile(pm.Source.File)
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
	s.commitCatalogChange(w, title, req.Author, map[string]any{
		"ok": true, "imported": imported, "skipped": skipped, "ignored": len(req.IgnoreFiles),
	})
}

// retireFile retires every parameter sourced from one (typically deleted)
// file: the one-click resolution for a file_deleted finding.
func (s *Server) retireFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		File   string `json:"file"`
		Author string `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.File == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file is required"})
		return
	}
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	names := make([]string, len(p.Registry.Instances))
	for i, inst := range p.Registry.Instances {
		names[i] = inst.Name
	}
	var ids []string
	for _, param := range p.Catalog.Parameters {
		if param.Source.File == req.File {
			ids = append(ids, param.ID)
		}
	}
	if len(ids) == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no parameters are sourced from that file"})
		return
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	for _, id := range ids {
		if err := writer.DeleteParameter(s.RepoPath, id, names); err != nil {
			writeErr(w, err)
			return
		}
	}
	s.commitCatalogChange(w, "Retire "+itoa(len(ids))+" parameter(s) from removed file "+req.File, req.Author,
		map[string]any{"ok": true, "retired": ids})
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
