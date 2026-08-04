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
	"github.com/abhijeet-oxide/configer/backend/internal/discovery"
	"github.com/abhijeet-oxide/configer/backend/internal/ingest"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/pathedit"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
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
// value is rejected with 422 either way), together with an add-parameter item
// for every setting the edit ADDED - so new settings reach the grid and the
// review rather than living only inside a file diff.
//
// @Summary     Stage a file edit
// @Description File-mode save: a direct Monaco edit of one file, staged into the same draft as grid edits. Edits that only change managed values become ordinary validated cell items (fan-out preserved); edits that touch unmanaged content stage as one whole-file item, plus one add-parameter item per setting the edit introduced that nothing managed yet (`newParameters` counts them). Managed values are always validated first.
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

	// Does it still parse? This is asked FIRST, of the whole document, before a
	// single item is staged. Reading the managed paths only notices damage that
	// happens to sit on the way to one of them, so a stray brace below every
	// managed value staged clean and was committed - and the file the cluster
	// then read was the broken one.
	if f := parseableFormat(req.Path); f != "" {
		if se := pathedit.CheckSyntax([]byte(req.Content), f); se != nil {
			writeSyntaxError(w, r, req.Path, se)
			return
		}
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

	// Unmanaged content changed: stage the whole file once, plus a parameter for
	// each setting the edit ADDS. Without the second half the new settings are
	// only bytes in a diff: the grid never shows them, and the review says the
	// file was "edited directly" while saying nothing about what now lives in it.
	catalog, added, moved, dropped := s.catalogDelta(p, inst, req.Path, committed, req.Content)
	_, err = s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
		cr.UpsertItem(change.Item{
			Instance: req.Instance, File: req.Path, Action: change.ActionEditFile,
			Old: committed, New: req.Content, UpdatedAt: time.Now().UTC(),
		})
		cr.ReplaceCatalogItems(req.Path, catalog)
		return nil
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "staged": 1 + len(catalog), "kind": "file",
		"managedChanges": len(changes), "newParameters": added,
		"movedParameters": moved, "droppedParameters": dropped,
	})
}

// duplicateEntry copies one entry of a repeated structure (an XML element that
// occurs several times under its parent, a YAML/JSON list entry) and stages the
// result exactly as a hand edit of the same file would be staged: one file item
// plus one new parameter per setting the copy brought with it.
//
// It exists because the alternative is real work done by hand. A telco config
// carries the same block per network, and adding one meant selecting twenty
// lines in the editor, pasting them, fixing the indentation, then hoping the
// paste landed somewhere that did not renumber the entries below it. The copy
// is always APPENDED after the last entry of its kind for that reason: these
// entries are addressed by position, so inserting one in the middle silently
// re-points every binding under it.
//
// @Summary     Duplicate a repeated entry
// @Description Copy one entry of a repeated structure in a file - an XML element that occurs several times under the same parent, or a YAML/JSON list entry - and stage the result in the current draft. The copy is appended AFTER the last entry of its kind so no existing entry is renumbered, and the settings it carries are staged as new parameters, exactly as if the block had been typed in by hand. XML is copied byte-for-byte (indentation and comments included). An entry identified by a key (`env[name=LOG_LEVEL]`) is refused: the copy would be a second entry with the same identity.
// @Tags        Files
// @Accept      json
// @Produce     json
// @Param       body body object true "{instance, file, path}"
// @Success     200 {object} object "newPath is the path the copy answers to"
// @Failure     400 {object} APIError "file and path are required"
// @Failure     404 {object} APIError "Unknown instance or file"
// @Failure     422 {object} APIError "The entry cannot be duplicated, or the file does not parse"
// @Security    CookieSession
// @Router      /api/files/duplicate [post]
func (s *Server) duplicateEntry(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Instance string `json:"instance"`
		File     string `json:"file"`
		Path     string `json:"path"`
		Author   string `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.File == "" || req.Path == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "file and path are required")
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
	clean := filepath.ToSlash(filepath.Clean(req.File))
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid file path")
		return
	}

	raw, rerr := os.ReadFile(filepath.Join(p.Root, filepath.FromSlash(clean)))
	if rerr != nil {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "that file is not in this repository")
		return
	}
	committed := string(raw)
	var items []change.Item
	if d := s.Store.CurrentDraft(draftOwner(r)); d != nil {
		items = d.Items
	}
	// Copy from what the user is LOOKING at (the draft applied), so duplicating
	// an entry they added a minute ago copies the entry they added.
	current, _ := applyDraftToFile(p, inst, clean, committed, items)

	format := formatForFile(clean)
	next, newPath, derr := pathedit.DuplicateEntry([]byte(current), format, req.Path)
	if derr != nil {
		writeError(w, r, http.StatusUnprocessableEntity, CodeValidationFailed, derr.Error())
		return
	}

	catalog, added, moved, dropped := s.catalogDelta(p, inst, clean, committed, next)
	defer s.lockDraft(draftOwner(r))()
	draft, err := s.Store.Draft(draftOwner(r), s.branch())
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, err := s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
		cr.UpsertItem(change.Item{
			Instance: req.Instance, File: clean, Action: change.ActionEditFile,
			Old: committed, New: next, UpdatedAt: time.Now().UTC(),
		})
		cr.ReplaceCatalogItems(clean, catalog)
		return nil
	}); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "file": clean, "newPath": newPath, "newParameters": added,
		"movedParameters": moved, "droppedParameters": dropped,
	})
}

// maxAddedParameters caps how many new settings ONE file edit may propose to
// start managing. A save that adds a handful of keys is the case this exists
// for; a save that pastes in a thousand-line file is an IMPORT, and the answer
// there is the onboarding scan, not a draft nobody can read. The file edit
// itself is staged either way, so nothing the user typed is lost.
const maxAddedParameters = 200

// catalogDelta works out what a file edit does to the CATALOG: the settings it
// introduced (one add-parameter item each) and the entries that moved or left,
// which the catalog has to follow (one realign-bindings item for the file).
//
// It is judged against the COMMITTED bytes, not against the draft-applied
// baseline the editor showed, so saving the same file twice says the same thing
// both times and taking a line back out withdraws its consequences.
//
// The second half is not a nicety. A repeated structure is addressed by
// POSITION, so adding one network in the middle of an XML file renumbers every
// network below it: `net-info[3]/net-id` keeps resolving, to a different
// network, and the grid quietly starts showing one network's values under
// another's name. Comparing the two versions by PATH cannot see that - it
// reports the tail of the file as new, a couple of paths as vanished, and says
// nothing about the ones that silently changed meaning. discovery.Realign lines
// the two versions up instead, so a person who added one block is told they
// added one block and the rest of the catalog follows its entries down.
func (s *Server) catalogDelta(
	p *project.Project, inst model.Instance, file, committed, edited string,
) (items []change.Item, added, moved, dropped int) {
	parser, err := s.Registry.ParserFor(file, []byte(edited))
	if err != nil {
		return nil, 0, 0, 0 // not a format we can read: the file edit stands on its own
	}
	newCands, err := parser.Extract(file, []byte(edited))
	if err != nil {
		return nil, 0, 0, 0 // unparsable: staging the bytes is all we can honestly do
	}
	var oldCands []plugin.Candidate
	if committed != "" {
		if oldCands, err = parser.Extract(file, []byte(committed)); err != nil {
			return nil, 0, 0, 0 // cannot tell new from old: say nothing rather than everything
		}
	}
	delta := discovery.Realign(file, oldCands, newCands)

	// Which catalog parameter sits at a given path in THIS file, for any
	// instance: a setting already managed is not a new one, whoever it belongs
	// to, and a setting that moved is one of these that has to follow it.
	owner := map[string]model.Parameter{}
	for _, param := range p.Catalog.Parameters {
		for _, b := range param.Bindings {
			if b.EffectiveLayer() == model.LayerBase {
				if b.File == file {
					owner[b.Path] = param
				}
				continue
			}
			for _, i := range p.Registry.Instances {
				if b.ForInstance(i).File == file {
					owner[b.Path] = param
				}
			}
		}
	}

	// The realignment: the catalog entries whose address changed, and the ones
	// whose value the edit took out of the file. Only paths the catalog actually
	// holds are named - a move of something nothing manages is not a change.
	var payload change.RealignPayload
	// The addresses the realignment VACATES. An insert in the middle shifts the
	// entries below it down, so the path the new block occupies is one the
	// catalog still holds - held by the entry that has just moved off it. Read
	// naively that looks like "already managed" and the block the person typed
	// in is proposed as nothing at all.
	freed := map[string]bool{}
	for _, m := range delta.Moved {
		param, ok := owner[m.From]
		if !ok {
			continue
		}
		// A relocation is the same setting in a different position of the same
		// structure. Anything else came out of an alignment that guessed, and
		// re-pointing on a guess is worse than not re-pointing at all.
		if !discovery.SameEntry(m.From, m.To) {
			continue
		}
		payload.Moves = append(payload.Moves, change.BindingMove{
			ParamID: param.ID, Name: param.Name, From: m.From, To: m.To,
		})
		freed[m.From] = true
	}
	for _, m := range payload.Moves {
		delete(freed, m.To) // something moved onto it, so it is not free after all
	}
	for _, path := range delta.Removed {
		if param, ok := owner[path]; ok {
			payload.Dropped = append(payload.Dropped, change.BindingMove{
				ParamID: param.ID, Name: param.Name, From: path,
			})
		}
	}

	// Where a new parameter binds: a file inside an instance's folder is that
	// instance's own layer and binds through {folder}; anything else is shared.
	rel, inFolder := "", false
	if folder := inst.FolderOrDefault(); inst.Name != "" && folder != "" && strings.HasPrefix(file, folder+"/") {
		rel, inFolder = strings.TrimPrefix(file, folder+"/"), true
	}
	used := map[string]bool{}
	for _, param := range p.Catalog.Parameters {
		used[param.ID] = true
	}

	items = make([]change.Item, 0, len(delta.Added)+1)
	for _, pm := range delta.Added {
		path := pm.Bindings[0].Path
		if pm.Name == "" || pm.ID == "" {
			continue // nothing to call it: a name is the whole point of managing it
		}
		// Already managed and staying that way: the edit did not introduce this
		// setting, it changed one.
		if _, taken := owner[path]; taken && !freed[path] {
			continue
		}
		if isIgnoredPath(p.Ignore, path) {
			continue
		}
		if added >= maxAddedParameters {
			break
		}
		id := pm.ID
		for n := 2; used[id]; n++ {
			id = fmt.Sprintf("%s-%d", pm.ID, n)
		}
		used[id] = true
		pm.ID = id
		if inFolder {
			pm.Scope = model.ScopeInstance
			pm.Bindings[0].File = "{folder}/" + rel
			// The value belongs to the instance whose folder it was found in,
			// not to every instance, so it travels as an observation rather
			// than as a default the others would inherit.
			pm.Observed = map[string]any{inst.Name: pm.Default}
			pm.Default = nil
		} else {
			pm.Scope = model.ScopeGlobal
		}
		added++
		items = append(items, change.Item{
			ParamID: pm.ID, Instance: inst.Name, File: file,
			Action: change.ActionAddParameter, New: pm, UpdatedAt: time.Now().UTC(),
		})
	}
	if len(payload.Moves) > 0 || len(payload.Dropped) > 0 {
		items = append(items, change.Item{
			Instance: inst.Name, File: file, Action: change.ActionRealignBindings,
			New: payload, UpdatedAt: time.Now().UTC(),
		})
	}
	return items, added, len(payload.Moves), len(payload.Dropped)
}

// isIgnoredPath reports whether .configer/ignore.yaml already says this path is
// not a setting - the record of somebody having decided exactly that, which a
// file edit must not quietly overturn.
func isIgnoredPath(ig project.Ignore, path string) bool {
	for _, p := range ig.Parameters {
		if p == path {
			return true
		}
	}
	return false
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
