package api

// Real-file access for an instance: the files inside its bound folder plus
// any shared (base-layer) files its parameters are bound to. Draft items are
// applied IN MEMORY through the pathedit engine, so previews show exactly the
// bytes a publish would commit without touching the working tree.

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/pathedit"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/validate"
)

// FileContent is one repository file (path relative to the repo root).
type FileContent struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// allInstancesSentinel is the pseudo-instance the Files explorer sends to see
// every instance's files at once (the default "All instances" view), so a
// parameter link always lands on its file no matter which instance the caller
// was looking at.
const allInstancesSentinel = "__all__"

// allInstanceFiles unions every instance's files (each with its own draft
// applied) plus the shared base files, de-duplicated by path. It reuses
// instanceFiles so a single code path governs how draft items land in a file.
// Shared base files are identical across instances after the (global) draft is
// applied, so the first occurrence wins and later duplicates are dropped.
func allInstanceFiles(p *project.Project, items []change.Item) ([]FileContent, error) {
	seen := map[string]bool{}
	out := make([]FileContent, 0)
	add := func(files []FileContent) {
		for _, fc := range files {
			if seen[fc.Path] {
				continue
			}
			seen[fc.Path] = true
			out = append(out, fc)
		}
	}
	for _, inst := range p.Registry.Instances {
		files, err := instanceFiles(p, inst.Name, items)
		if err != nil {
			return nil, err
		}
		add(files)
	}
	// Instances that exist only as a pending draft add have no folder on disk
	// yet; include their synthesized files so the new folder shows up too.
	for _, it := range items {
		if it.Act() != change.ActionAddInstance {
			continue
		}
		if _, exists := p.InstanceByName(it.Instance); exists {
			continue
		}
		if files, pending := pendingInstanceFiles(p, it.Instance, items); pending {
			add(files)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// instanceFiles lists the real files that make up one instance's
// configuration, with pending draft items applied in memory.
//
// A brand-new instance that only exists as a pending draft add has no folder
// on disk yet; its files are synthesized (a preview of the folder submit will
// scaffold) so the Files explorer shows the new folder as a pending addition
// instead of "instance not found".
func instanceFiles(p *project.Project, instanceName string, items []change.Item) ([]FileContent, error) {
	inst, ok := p.InstanceByName(instanceName)
	if !ok {
		if files, pending := pendingInstanceFiles(p, instanceName, items); pending {
			return files, nil
		}
		return nil, errInstanceNotFound(instanceName)
	}

	paths := map[string]bool{}

	// Every file under the instance's folder.
	folder := inst.FolderOrDefault()
	root := filepath.Join(p.Root, folder)
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		rel, rerr := filepath.Rel(p.Root, path)
		if rerr != nil {
			return nil
		}
		paths[filepath.ToSlash(rel)] = true
		return nil
	})

	// Plus shared files this application's parameters are bound to.
	for _, param := range p.Catalog.Parameters {
		for _, b := range param.Bindings {
			if b.EffectiveLayer() == model.LayerBase {
				paths[b.File] = true
			}
		}
	}

	sorted := make([]string, 0, len(paths))
	for f := range paths {
		sorted = append(sorted, f)
	}
	sort.Strings(sorted)

	out := make([]FileContent, 0, len(sorted))
	for _, f := range sorted {
		b, err := os.ReadFile(filepath.Join(p.Root, f))
		if err != nil {
			continue // racing deletion: skip rather than fail the listing
		}
		content, err := applyDraftToFile(p, inst, f, string(b), items)
		if err != nil {
			return nil, err
		}
		out = append(out, FileContent{Path: f, Content: content})
	}
	return out, nil
}

// pendingInstanceFiles previews the files of an instance that exists only as a
// pending draft add. For a clone it mirrors the source folder into the new
// folder (dir(sourceFolder)/name, matching the layout adapter) so the explorer
// shows the whole scaffolded tree; for an empty instance it shows the shared
// files alone. Staged value edits for the new instance are applied on top.
func pendingInstanceFiles(p *project.Project, name string, items []change.Item) ([]FileContent, bool) {
	var add *change.Item
	for i := range items {
		if items[i].Act() == change.ActionAddInstance && items[i].Instance == name {
			add = &items[i]
			break
		}
	}
	if add == nil {
		return nil, false
	}

	// The synthetic instance: the pending metadata, plus the folder submit
	// will create, so instance-layer bindings expand to the right files.
	inst := model.Instance{Name: name}
	if b, err := json.Marshal(add.New); err == nil {
		_ = json.Unmarshal(b, &inst)
	}

	contents := map[string]string{} // path -> committed bytes
	cloneFrom, _ := add.Old.(string)
	if src, ok := p.InstanceByName(cloneFrom); ok {
		srcFolder := src.FolderOrDefault()
		newFolder := filepath.ToSlash(filepath.Join(filepath.Dir(srcFolder), name))
		inst.Folder = newFolder
		base := filepath.Join(p.Root, filepath.FromSlash(srcFolder))
		_ = filepath.WalkDir(base, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !d.Type().IsRegular() {
				return nil
			}
			rel, rerr := filepath.Rel(base, path)
			if rerr != nil {
				return nil
			}
			b, rerr := os.ReadFile(path)
			if rerr != nil {
				return nil
			}
			contents[filepath.ToSlash(filepath.Join(newFolder, rel))] = string(b)
			return nil
		})
	} else if inst.Folder == "" {
		inst.Folder = "instances/" + name
	}

	// Shared (base-layer) files this application's parameters bind to.
	for _, param := range p.Catalog.Parameters {
		for _, b := range param.Bindings {
			if b.EffectiveLayer() == model.LayerBase {
				if _, seen := contents[b.File]; !seen {
					if raw, err := os.ReadFile(filepath.Join(p.Root, filepath.FromSlash(b.File))); err == nil {
						contents[b.File] = string(raw)
					}
				}
			}
		}
	}

	paths := make([]string, 0, len(contents))
	for f := range contents {
		paths = append(paths, f)
	}
	sort.Strings(paths)
	out := make([]FileContent, 0, len(paths))
	for _, f := range paths {
		content, err := applyDraftToFile(p, inst, f, contents[f], items)
		if err != nil {
			content = contents[f]
		}
		out = append(out, FileContent{Path: f, Content: content})
	}
	return out, true
}

// applyDraftToFile applies the draft items that land in file f (for this
// instance) onto content, in memory: a direct file edit replaces the content
// wholesale, then staged value items refine on top.
func applyDraftToFile(p *project.Project, inst model.Instance, f, content string, items []change.Item) (string, error) {
	for _, it := range items {
		if it.Act() == change.ActionEditFile && it.File == f {
			if c, ok := it.New.(string); ok {
				content = c
			}
		}
	}
	for _, it := range items {
		if it.Structural() || it.Act() == change.ActionEditFile {
			continue
		}
		if it.Scope != "global" && it.Instance != inst.Name {
			continue
		}
		param, ok := p.ParamByID(it.ParamID)
		if !ok {
			continue
		}
		layer := model.LayerInstance
		if it.Scope == "global" {
			layer = model.LayerBase
		}
		for _, b := range param.BindingsOn(layer, inst) {
			if b.File != f {
				continue
			}
			var err error
			if it.Act() == change.ActionSet {
				content, err = pathedit.Set([]byte(content), b.Format, b.Path, param.Type, it.New)
			} else {
				content, err = pathedit.Remove([]byte(content), b.Format, b.Path, param.Type)
			}
			if err != nil {
				return "", err
			}
		}
	}
	return content, nil
}

type errInstanceNotFound string

func (e errInstanceNotFound) Error() string {
	return "instance " + strings.TrimSpace(string(e)) + " not found"
}

// stageFileEdit is file mode's save path (PUT /api/files/draft): a direct
// Monaco edit of one file, staged into the SAME draft as grid edits.
//
// Reverse sync: when the edit only changes MANAGED values, it is staged as
// ordinary validated cell items - so a deduplicated parameter still fans out
// to its other locations on submit, and the grid shows the pending cells.
// When unmanaged content changed too, the whole file content is staged as
// one edit-file item (managed values are still validated first: an invalid
// value is rejected with 422 either way).
//
// @Summary     Stage a file edit
// @Description File-mode save: a direct Monaco edit of one file, staged into the same draft as grid edits. Edits that only change managed values become ordinary validated cell items (fan-out preserved); edits that touch unmanaged content stage as one whole-file item. Managed values are always validated first.
// @Tags        Files
// @Accept      json
// @Produce     json
// @Param       body body FileEditRequest true "The file edit"
// @Success     200 {object} map[string]interface{} "kind is values | file"
// @Failure     400 {object} APIError "path and content are required"
// @Failure     404 {object} APIError "Unknown instance"
// @Failure     422 {object} APIError "A managed value failed validation, or the file does not parse"
// @Security    CookieSession
// @Router      /api/files/draft [put]
func (s *Server) stageFileEdit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Instance string `json:"instance"`
		Path     string `json:"path"`
		Content  string `json:"content"`
		Author   string `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Path == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "path and content are required")
		return
	}
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	inst, ok := p.InstanceByName(req.Instance)
	if !ok && req.Instance != "" {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "instance not found")
		return
	}

	// Baseline = the file as the user last saw it (draft applied).
	committed := ""
	if b, rerr := os.ReadFile(filepath.Join(p.Root, filepath.FromSlash(req.Path))); rerr == nil {
		committed = string(b)
	}
	var items []change.Item
	if d := s.Store.CurrentDraft(); d != nil {
		items = d.Items
	}
	old, err := applyDraftToFile(p, inst, req.Path, committed, items)
	if err != nil {
		writeErr(w, err)
		return
	}
	if old == req.Content {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "staged": 0, "detail": "no changes"})
		return
	}

	// Detect managed value changes at this path, validating each.
	type valueChange struct {
		param    model.Parameter
		binding  model.Binding
		scope    string
		instName string
		oldV     any
		newV     any
		removed  bool
	}
	var changes []valueChange
	for _, param := range p.Catalog.Parameters {
		for _, b := range param.Bindings {
			concrete := b
			scope, instName := "", inst.Name
			if b.EffectiveLayer() == model.LayerBase {
				scope, instName = "global", ""
			} else {
				if req.Instance == "" {
					continue
				}
				concrete = b.ForInstance(inst)
			}
			if concrete.File != req.Path {
				continue
			}
			oldV, oldOK, _ := pathedit.Get([]byte(old), concrete.Format, concrete.Path)
			newV, newOK, gerr := pathedit.Get([]byte(req.Content), concrete.Format, concrete.Path)
			if gerr != nil {
				writeError(w, r, http.StatusUnprocessableEntity, CodeValidationFailed, "the file does not parse: "+gerr.Error())
				return
			}
			if fmt.Sprintf("%v|%v", oldV, oldOK) == fmt.Sprintf("%v|%v", newV, newOK) {
				continue
			}
			if newOK {
				coerced, cerr := validate.CoerceValue(param, newV)
				if cerr != nil {
					writeFieldErrors(w, r, "a value in this file is not valid", FieldError{Field: param.Name, Message: cerr.Error()})
					return
				}
				if vr := validate.Value(param, coerced); !vr.Valid {
					writeFieldErrors(w, r, "a value in this file is not valid", FieldError{Field: param.Name, Message: vr.Message})
					return
				}
				newV = coerced
			}
			changes = append(changes, valueChange{
				param: param, binding: concrete, scope: scope, instName: instName,
				oldV: oldV, newV: newV, removed: !newOK,
			})
		}
	}

	// Pure value edit? Reconstruct the file from the detected changes: a
	// byte-identical result proves nothing unmanaged moved.
	reconstructed := old
	for _, ch := range changes {
		var rerr error
		if ch.removed {
			reconstructed, rerr = pathedit.Remove([]byte(reconstructed), ch.binding.Format, ch.binding.Path, ch.param.Type)
		} else {
			reconstructed, rerr = pathedit.Set([]byte(reconstructed), ch.binding.Format, ch.binding.Path, ch.param.Type, ch.newV)
		}
		if rerr != nil {
			reconstructed = "" // force the raw-file path below
			break
		}
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	draft, err := s.Store.Draft(author(r, req.Author), s.branch())
	if err != nil {
		writeErr(w, err)
		return
	}

	if reconstructed == req.Content && len(changes) > 0 {
		// Managed values only: stage as ordinary cell items.
		_, err = s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
			for _, ch := range changes {
				it := change.Item{
					ParamID: ch.param.ID, Instance: ch.instName, Scope: ch.scope,
					Old: ch.oldV, New: ch.newV, UpdatedAt: time.Now().UTC(),
				}
				if ch.removed {
					it.Action = change.ActionReset
				}
				cr.UpsertItem(it)
			}
			return nil
		})
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "staged": len(changes), "kind": "values"})
		return
	}

	// Unmanaged content changed: stage the whole file once.
	_, err = s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
		cr.UpsertItem(change.Item{
			Instance: req.Instance, File: req.Path, Action: change.ActionEditFile,
			Old: committed, New: req.Content, UpdatedAt: time.Now().UTC(),
		})
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "staged": 1, "kind": "file", "managedChanges": len(changes)})
}
