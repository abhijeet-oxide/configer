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
	"github.com/abhijeet-oxide/configer/backend/internal/ingest"
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
		if err != nil {
			return nil
		}
		if d.IsDir() {
			// A tool's own directory (.git, .vscode, __pycache__) is not this
			// instance's configuration; showing it buries the files that are.
			if path != root && ingest.SkipDir(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
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
		content, _ := applyDraftToFile(p, inst, f, string(b), items)
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
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if path != base && ingest.SkipDir(d.Name()) {
					return filepath.SkipDir
				}
				return nil
			}
			if !d.Type().IsRegular() {
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
		content, _ := applyDraftToFile(p, inst, f, contents[f], items)
		out = append(out, FileContent{Path: f, Content: content})
	}
	return out, true
}

// applyDraftToFile applies the draft items that land in file f (for this
// instance) onto content, in memory: a direct file edit replaces the content
// wholesale, then staged value items refine on top.
//
// An item that CANNOT be written into this file is skipped, and named in the
// returned list. Every caller here is previewing a file, and a stale mapping
// (one whose path no longer fits the file) must not blank the explorer or make
// the file uneditable - which is what returning the error did: one unwritable
// staged edit answered the whole listing with "index 2 out of range". The review
// dialog is where such an item is reported by name, and submit is where it is
// refused.
func applyDraftToFile(p *project.Project, inst model.Instance, f, content string, items []change.Item) (string, []string) {
	var skipped []string
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
			var (
				out string
				err error
			)
			if it.Act() == change.ActionSet {
				out, err = pathedit.Set([]byte(content), b.Format, b.Path, param.Type, it.New)
			} else {
				out, err = pathedit.Remove([]byte(content), b.Format, b.Path, param.Type)
			}
			if err != nil {
				// Keep what the file already had: a half-applied preview would
				// show the user a file that exists nowhere.
				skipped = append(skipped, it.ParamID)
				continue
			}
			content = out
		}
	}
	return content, skipped
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
	if d := s.Store.CurrentDraft(draftOwner(r)); d != nil {
		items = d.Items
	}
	// The same baseline the explorer showed, skips and all, so the diff below is
	// against what the user actually edited rather than against a file they
	// never saw.
	old, _ := applyDraftToFile(p, inst, req.Path, committed, items)
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
				if vr := validate.UnitChange(param, oldV, coerced); !vr.Valid {
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

	defer s.lockDraft(draftOwner(r))()
	draft, err := s.Store.Draft(draftOwner(r), s.branch())
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

// ManagedValue is one value inside a file that Configer manages: which
// parameter owns it, where it is in the file, and the line it sits on in the
// content the Files explorer is showing.
type ManagedValue struct {
	ParamID string `json:"paramId"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Line    int    `json:"line"`
	// Col/EndCol bracket the VALUE on that line (1-based, end exclusive), so
	// the editor can mark "10.0.0.1" rather than the whole of
	// "  ip: 10.0.0.1  # the service ip". Zero when the value cannot be
	// narrowed (a block scalar), and the caller marks the line instead.
	Col    int `json:"col,omitempty"`
	EndCol int `json:"endCol,omitempty"`
	Type    string `json:"type,omitempty"`
	Secret  bool   `json:"secret,omitempty"`
	// Instance is the instance whose folder this file belongs to, empty for a
	// shared (base-layer) file that every instance reads.
	Instance string `json:"instance,omitempty"`
}

// managedValues answers "which lines of this file does Configer look after".
//
// A file in the explorer is mostly ordinary text with a handful of values the
// product actually manages, and until now nothing said which. The lines are
// located in the SAME content the explorer renders - the draft applied in
// memory - so a highlight cannot drift a line away from the value it marks.
//
// @Summary     Managed values in a file
// @Description Every value in one file that a catalog parameter is bound to, with the 1-based line it sits on in the draft-applied content the Files explorer shows, and the columns the value itself occupies on that line. Lets the editor mark exactly the managed values. A value that cannot be narrowed (a block scalar) reports columns 0 and is marked by line.
// @Tags        Files
// @Produce     json
// @Param       file     query string true  "Repository-relative file path"
// @Param       instance query string false "Instance whose draft/expansion to use (default: every instance)"
// @Success     200 {object} object
// @Failure     400 {object} APIError "file is required"
// @Router      /api/files/managed [get]
func (s *Server) managedValues(w http.ResponseWriter, r *http.Request) {
	file := strings.TrimSpace(r.URL.Query().Get("file"))
	if file == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "file is required")
		return
	}
	clean := filepath.ToSlash(filepath.Clean(file))
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid file path")
		return
	}
	p, draft, err := s.loadWithDraft(draftOwner(r))
	if err != nil {
		writeErr(w, err)
		return
	}
	var items []change.Item
	if draft != nil {
		items = draft.Items
	}

	// Which instances to expand {folder}/{instance} bindings for: the one in
	// view, or all of them for the explorer's default "All instances".
	want := strings.TrimSpace(r.URL.Query().Get("instance"))
	instances := p.Registry.Instances
	if want != "" && want != allInstancesSentinel {
		inst, ok := p.InstanceByName(want)
		if !ok {
			writeJSON(w, http.StatusOK, map[string]any{"file": clean, "values": []ManagedValue{}})
			return
		}
		instances = []model.Instance{inst}
	}

	raw, err := os.ReadFile(filepath.Join(s.RepoPath, filepath.FromSlash(clean)))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"file": clean, "values": []ManagedValue{}})
		return
	}
	// Apply the draft ONCE per instance and parse the result ONCE per format:
	// a values file carries dozens of managed keys, and doing either per
	// parameter is the difference between one pass over the bytes and a hundred.
	applied := map[string]string{}
	contentFor := func(inst model.Instance) string {
		if c, ok := applied[inst.Name]; ok {
			return c
		}
		c, _ := applyDraftToFile(p, inst, clean, string(raw), items)
		applied[inst.Name] = c
		return c
	}
	docs := map[string]*pathedit.Document{}
	docFor := func(content, format string) *pathedit.Document {
		key := format + "\x00" + content
		if d, ok := docs[key]; ok {
			return d
		}
		d, derr := pathedit.Parse([]byte(content), format)
		if derr != nil {
			d = nil
		}
		docs[key] = d
		return d
	}

	out := make([]ManagedValue, 0)
	seen := map[string]bool{}
	for _, param := range p.Catalog.Parameters {
		for _, b := range param.Bindings {
			if b.EffectiveLayer() == model.LayerBase {
				if filepath.ToSlash(b.File) != clean {
					continue
				}
				// A shared file reads the same for everyone: the draft's
				// global items apply with no instance in hand.
				addManaged(&out, seen, docFor(contentFor(model.Instance{}), b.Format), param, b, "")
				continue
			}
			for _, inst := range instances {
				eb := b.ForInstance(inst)
				if filepath.ToSlash(eb.File) != clean {
					continue
				}
				addManaged(&out, seen, docFor(contentFor(inst), eb.Format), param, eb, inst.Name)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Line != out[j].Line {
			return out[i].Line < out[j].Line
		}
		return out[i].ParamID < out[j].ParamID
	})
	writeJSON(w, http.StatusOK, map[string]any{"file": clean, "values": out})
}

// addManaged appends one located value, skipping duplicates (a deduplicated
// parameter can reach the same line through several instances' bindings) and
// values the file does not actually carry.
func addManaged(out *[]ManagedValue, seen map[string]bool, doc *pathedit.Document, param model.Parameter, b model.Binding, instance string) {
	if doc == nil {
		return
	}
	line, col, endCol, ok := doc.Span(b.Path)
	if !ok || line <= 0 {
		return
	}
	key := param.ID + "\x00" + b.Path
	if seen[key] {
		return
	}
	seen[key] = true
	*out = append(*out, ManagedValue{
		ParamID: param.ID, Name: param.Name, Path: b.Path,
		Line: line, Col: col, EndCol: endCol,
		Type: string(param.Type), Secret: param.Secret, Instance: instance,
	})
}
