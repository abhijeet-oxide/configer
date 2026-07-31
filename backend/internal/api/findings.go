package api

// What arrived on Git, said in the product's own words.
//
// Configer is a wrapper over an ordinary repository, so a change made in an
// editor, by a pipeline, or by another team is exactly as real as one made
// here. This file is what makes that claim visible. It reads the range between
// the commit the user last acknowledged and HEAD and reports what happened in
// the vocabulary of the product rather than of git: an INSTANCE appeared, an
// instance went away, a software VERSION moved, new SETTINGS turned up in a
// file already managed. Only what fits none of those falls back to file-level
// news.
//
// Every finding carries WHO did it and WHEN, because "a file changed" is not
// something anybody can act on and "Dana added a site an hour ago" is.
//
// A finding is never applied on its own. It offers the ordinary workflow -
// stage it in a draft, review it, publish it - so the repository stays the
// source of truth and Configer stays a way of working with it.

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/ingest"
	"github.com/abhijeet-oxide/configer/backend/internal/layout"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/repobackend"
)

// Finding types, in the order a reader cares about them. The first four are
// about the ESTATE (an instance, a version); the rest are about files, and are
// what is left when nothing larger explains the change.
const (
	FindingInstanceGone   = "instance_gone"   // a managed instance's folder is gone
	FindingNewInstance    = "new_instance"    // a config folder nobody manages yet
	FindingVersionChanged = "version_changed" // an instance's software version moved
	FindingNewParameters  = "new_parameters"  // new settings inside a managed file
	FindingFileDeleted    = "file_deleted"
	FindingFileRenamed    = "file_renamed"
	FindingFileChanged    = "file_changed"
	FindingNewFile        = "new_file"
	FindingNewFolder      = "new_folder"
)

var findingRank = map[string]int{
	FindingInstanceGone: 0, FindingNewInstance: 1, FindingVersionChanged: 2,
	FindingNewParameters: 3, FindingFileDeleted: 4, FindingFileRenamed: 5,
	FindingFileChanged: 6, FindingNewFile: 7, FindingNewFolder: 8,
}

// FindingCommit is the provenance of a finding: the commit that did it. It is
// not decoration. Deciding what to do about a change means knowing whether it
// came from a colleague ten minutes ago or from a pipeline last month, and a
// bare path answers neither.
type FindingCommit struct {
	SHA     string `json:"sha"`
	Short   string `json:"short"`
	Author  string `json:"author"`
	Date    string `json:"date"`
	Message string `json:"message"`
}

// Finding is one repository event Configer detected between the acknowledged
// commit and HEAD.
type Finding struct {
	Type string `json:"type"`
	Path string `json:"path"`
	// OldPath is set for renames.
	OldPath string `json:"oldPath,omitempty"`
	// Candidates counts extractable parameters not already in the catalog.
	Candidates int `json:"candidates,omitempty"`
	// Params lists managed parameter IDs affected by a change or deletion.
	Params []string `json:"params,omitempty"`
	// Instance names the instance a finding is about (new, gone, or moved).
	Instance string `json:"instance,omitempty"`
	// Proposed is the registry entry adopting a new instance would create, so
	// the UI can offer "manage it" with the name and environment filled in.
	Proposed *model.Instance `json:"proposed,omitempty"`
	// From/To carry a software version move.
	From string `json:"from,omitempty"`
	To   string `json:"to,omitempty"`
	// Files are the configuration files a folder-level finding covers.
	Files []string `json:"files,omitempty"`
	// Commit is who did this, and when.
	Commit *FindingCommit `json:"commit,omitempty"`
	// Detail is a human sentence describing what happened and what to do.
	Detail string `json:"detail"`
}

const (
	ackKey      = "reconcileAckSha"
	versionsKey = "reconcileVersions"
	// instanceScanCap bounds the work one poll may do looking into folders
	// nobody manages yet: enough to describe a realistic drop, bounded so a
	// repository with a hundred unmanaged folders cannot make the poll
	// expensive.
	instanceScanCap = 25
	// provenanceCap bounds the per-path history lookups one poll may do.
	provenanceCap = 60
)

// findings computes repository events between the acknowledged SHA and HEAD.
//
// @Summary     Repository findings
// @Description What changed on Git outside Configer since the last acknowledged commit, classified in the product's own terms: `new_instance` (a configuration folder nobody manages yet, with the registry entry adopting it would create), `instance_gone`, `version_changed` (an instance's software version moved, with from/to), `new_parameters` (new settings inside a file already managed), and the file-level fallbacks `new_file`, `file_changed`, `file_deleted`, `file_renamed`, `new_folder`. Each finding carries the commit that caused it: sha, author, date and message.
// @Tags        Import & reconcile
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Failure     500 {object} APIError
// @Router      /api/repo/findings [get]
func (s *Server) findings(w http.ResponseWriter, r *http.Request) {
	head, err := s.Backend.HeadSHA(r.Context(), "HEAD")
	if err != nil {
		writeErr(w, err)
		return
	}
	p, _ := s.load()

	ack := s.Store.GetMeta(ackKey)
	if ack == "" {
		// First run: everything up to now is the baseline, not news.
		_ = s.Store.SetMeta(ackKey, head)
		s.baselineVersions(p)
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

	managedBy, managedPath := managedIndex(p)

	// Estate-level findings first, and they claim the paths they explain: a
	// new site is ONE thing that happened, not eleven new files, and an
	// instance that was deleted is not a list of vanished parameters.
	out := []Finding{}
	claimed := []string{}
	gone := s.missingInstanceFindings(p)
	for _, f := range gone {
		claimed = append(claimed, f.Path)
	}
	out = append(out, gone...)

	fresh := s.newInstanceFindings(p, managedPath)
	for _, f := range fresh {
		claimed = append(claimed, f.Path)
	}
	out = append(out, fresh...)

	out = append(out, s.versionFindings(p)...)
	out = append(out, s.fileFindings(changes, managedBy, managedPath, claimed)...)

	s.attributeCommits(r.Context(), out)
	sort.SliceStable(out, func(i, j int) bool {
		if findingRank[out[i].Type] != findingRank[out[j].Type] {
			return findingRank[out[i].Type] < findingRank[out[j].Type]
		}
		return out[i].Path < out[j].Path
	})
	writeJSON(w, http.StatusOK, map[string]any{"baseSha": ack, "headSha": head, "findings": out})
}

// managedIndex maps every concrete file the catalog reads to the parameters
// that read it, and every file+path pair already in the catalog. Templated
// (instance-layer) bindings expand to one concrete file per instance.
func managedIndex(p *project.Project) (managedBy map[string][]string, managedPath map[string]bool) {
	managedBy, managedPath = map[string][]string{}, map[string]bool{}
	if p == nil {
		return
	}
	add := func(b model.Binding, id string) {
		managedBy[b.File] = append(managedBy[b.File], id)
		managedPath[b.File+"|"+b.Path] = true
	}
	for _, param := range p.Catalog.Parameters {
		for _, b := range param.Bindings {
			if b.EffectiveLayer() == model.LayerBase {
				add(b, param.ID)
				continue
			}
			for _, inst := range p.Registry.Instances {
				add(b.ForInstance(inst), param.ID)
			}
		}
	}
	return
}

// newInstanceFindings reports configuration folders the repository has and the
// catalog does not: somebody stood up a site, and Configer should offer to
// manage it rather than describe its files one by one.
//
// This is deliberately NOT limited to the acknowledged range. A folder nobody
// manages is a STATE, true until it is adopted or ignored, exactly like a
// parameter pointing at a file that no longer exists. An ignore rule covering
// the folder is how somebody says "not that one" for good.
func (s *Server) newInstanceFindings(p *project.Project, managedPath map[string]bool) []Finding {
	if p == nil {
		return nil
	}
	kind := ""
	if p.App.Layout != "" {
		kind = p.App.Layout
	}
	det, ok := layout.ForKind(kind).Detect(s.RepoPath)
	if !ok {
		return nil
	}
	known := map[string]bool{}
	for _, inst := range p.Registry.Instances {
		known[strings.Trim(filepath.ToSlash(inst.FolderOrDefault()), "/")] = true
	}
	var out []Finding
	for _, cand := range det.Instances {
		folder := strings.Trim(filepath.ToSlash(cand.Folder), "/")
		if folder == "" || known[folder] || folderIgnored(folder, p.Ignore.Files) {
			continue
		}
		if len(out) >= instanceScanCap {
			break
		}
		files, count := s.folderCandidates(folder, managedPath)
		out = append(out, Finding{
			Type:       FindingNewInstance,
			Path:       folder + "/",
			Instance:   cand.Name,
			Candidates: count,
			Files:      files,
			Proposed: &model.Instance{
				Name: cand.Name, Folder: folder,
				Environment: cand.Environment, Status: "active",
			},
			Detail: "This looks like an instance the repository has and Configer does not manage yet. Manage it to add it as a column and bring its values into the grid.",
		})
	}
	return out
}

// folderCandidates lists the configuration files under a folder and counts the
// settings in them that are not in the catalog yet.
func (s *Server) folderCandidates(folder string, managedPath map[string]bool) ([]string, int) {
	var files []string
	count := 0
	root := filepath.Join(s.RepoPath, filepath.FromSlash(folder))
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil //nolint:nilerr // an unreadable corner is not news
		}
		if d.IsDir() {
			if path != root && ingest.SkipDir(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if len(files) >= instanceScanCap {
			return filepath.SkipAll
		}
		rel, rerr := filepath.Rel(s.RepoPath, path)
		if rerr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		content, rerr := os.ReadFile(path)
		if rerr != nil {
			return nil
		}
		parser, perr := s.Registry.ParserFor(rel, content)
		if perr != nil {
			return nil // not a configuration file
		}
		files = append(files, rel)
		cands, _ := parser.Extract(rel, content)
		for _, c := range cands {
			if !managedPath[rel+"|"+c.Path] {
				count++
			}
		}
		return nil
	})
	return files, count
}

// missingInstanceFindings reports a registered instance whose folder is no
// longer in the repository. Said once, as the loss of an instance, rather than
// once per file that went with it.
func (s *Server) missingInstanceFindings(p *project.Project) []Finding {
	if p == nil {
		return nil
	}
	var out []Finding
	for _, inst := range p.Registry.Instances {
		folder := strings.Trim(filepath.ToSlash(inst.FolderOrDefault()), "/")
		if folder == "" {
			continue
		}
		if _, err := os.Stat(filepath.Join(s.RepoPath, filepath.FromSlash(folder))); !os.IsNotExist(err) {
			continue
		}
		out = append(out, Finding{
			Type:     FindingInstanceGone,
			Path:     folder + "/",
			Instance: inst.Name,
			Detail:   "This instance's folder is no longer in the repository. Retire the instance, or restore the folder on Git.",
		})
	}
	return out
}

// versionFindings reports instances whose software version moved since the
// last acknowledged look. The versions are remembered rather than read back
// out of git, so noticing an upgrade costs nothing on a poll.
//
// A version bump published through Configer shows up here too. That is the
// point: the question this answers is "which instances are on something new",
// and the answer does not depend on who typed it.
func (s *Server) versionFindings(p *project.Project) []Finding {
	if p == nil {
		return nil
	}
	prev := map[string]string{}
	raw := s.Store.GetMeta(versionsKey)
	if raw == "" {
		s.baselineVersions(p)
		return nil
	}
	if err := json.Unmarshal([]byte(raw), &prev); err != nil {
		s.baselineVersions(p)
		return nil
	}
	var out []Finding
	for _, inst := range p.Registry.Instances {
		was, known := prev[inst.Name]
		if !known || was == "" || was == inst.SoftwareVersion || inst.SoftwareVersion == "" {
			continue
		}
		out = append(out, Finding{
			Type:     FindingVersionChanged,
			Path:     strings.Trim(filepath.ToSlash(inst.FolderOrDefault()), "/") + "/",
			Instance: inst.Name,
			From:     was,
			To:       inst.SoftwareVersion,
			Detail: "This instance moved to " + inst.SoftwareVersion +
				". Check the parameters that arrive with it, and any that it retires.",
		})
	}
	return out
}

// baselineVersions records the versions in force now, so only later moves read
// as news.
func (s *Server) baselineVersions(p *project.Project) {
	if p == nil {
		return
	}
	cur := map[string]string{}
	for _, inst := range p.Registry.Instances {
		cur[inst.Name] = inst.SoftwareVersion
	}
	if b, err := json.Marshal(cur); err == nil {
		_ = s.Store.SetMeta(versionsKey, string(b))
	}
}

// fileFindings is the file-level fallback: everything in the acknowledged
// range that no estate-level finding already explained.
func (s *Server) fileFindings(changes []repobackend.FileChange,
	managedBy map[string][]string, managedPath map[string]bool, claimed []string) []Finding {
	out := []Finding{}
	newDirs := map[string]int{}
	reportedGone := map[string]bool{}
	for _, c := range changes {
		path := filepath.ToSlash(c.Path)
		if strings.HasPrefix(path, ".configer/") {
			continue // Configer's own artifacts are not "external" news
		}
		if underAny(path, claimed) {
			continue // an instance-level finding already said this
		}
		switch c.Status {
		case "A":
			fresh, ok := s.freshCandidates(path, managedPath)
			if !ok || fresh == 0 {
				continue
			}
			out = append(out, Finding{
				Type: FindingNewFile, Path: path, Candidates: fresh,
				Detail: "A new configuration file appeared in the repository. You can import its parameters or ignore it.",
			})
			// Name the folder the files actually landed in, not the bucket
			// they landed under: "instances/" is never news, and reducing
			// every path to its first segment made every drop say exactly
			// that.
			if dir := filepath.ToSlash(filepath.Dir(path)); dir != "." && dir != "base" {
				newDirs[dir]++
			}
		case "M":
			ids := managedBy[path]
			if len(ids) == 0 {
				continue
			}
			// A managed file that gained SETTINGS is a schema change, and it is
			// the interesting half of "somebody edited a file": new keys are
			// the ones nobody has decided about yet.
			if fresh, ok := s.freshCandidates(path, managedPath); ok && fresh > 0 {
				out = append(out, Finding{
					Type: FindingNewParameters, Path: path, Params: ids, Candidates: fresh,
					Detail: "This managed file gained settings Configer does not track yet. Import them to bring them into the grid.",
				})
				continue
			}
			out = append(out, Finding{
				Type: FindingFileChanged, Path: path, Params: ids,
				Detail: "A managed file was changed directly on Git. The grid already shows the new values.",
			})
		case "D":
			if ids := managedBy[path]; len(ids) > 0 {
				reportedGone[path] = true
				out = append(out, Finding{
					Type: FindingFileDeleted, Path: path, Params: ids,
					Detail: "A file that parameters are sourced from was deleted on Git. Retire the affected parameters or restore the file.",
				})
			}
		case "R":
			old := filepath.ToSlash(c.OldPath)
			if ids := managedBy[old]; len(ids) > 0 {
				reportedGone[old] = true
				out = append(out, Finding{
					Type: FindingFileRenamed, Path: path, OldPath: old, Params: ids,
					Detail: "A managed file was renamed on Git. Its parameters still point at the old path.",
				})
			}
		}
	}
	// Safety net beyond the diff: a managed source file can be missing even
	// when the ack..HEAD range never shows a "D" (added and deleted inside one
	// unacknowledged window, or gone since before the baseline). Parameters
	// pointing at a missing file always deserve a finding.
	for file, ids := range managedBy {
		if reportedGone[file] || underAny(file, claimed) {
			continue
		}
		if _, err := os.Stat(filepath.Join(s.RepoPath, file)); os.IsNotExist(err) {
			out = append(out, Finding{
				Type: FindingFileDeleted, Path: file, Params: ids,
				Detail: "A file that parameters are sourced from no longer exists in the repository. Retire the affected parameters or restore the file.",
			})
		}
	}
	for dir, n := range newDirs {
		if n >= 2 {
			out = append(out, Finding{
				Type: FindingNewFolder, Path: dir + "/", Candidates: n,
				Detail: "Several new configuration files appeared under one folder, possibly a new software version drop. Scan it to introduce or deprecate parameters.",
			})
		}
	}
	return out
}

// freshCandidates counts the settings in one file that the catalog does not
// already carry. ok is false when the file is not configuration Configer can
// read at all.
func (s *Server) freshCandidates(path string, managedPath map[string]bool) (int, bool) {
	content, err := os.ReadFile(filepath.Join(s.RepoPath, filepath.FromSlash(path)))
	if err != nil {
		return 0, false
	}
	parser, perr := s.Registry.ParserFor(path, content)
	if perr != nil {
		return 0, false
	}
	cands, _ := parser.Extract(path, content)
	fresh := 0
	for _, c := range cands {
		if !managedPath[path+"|"+c.Path] {
			fresh++
		}
	}
	return fresh, true
}

// attributeCommits names the commit behind each finding: who did this, when,
// and what they said they were doing.
func (s *Server) attributeCommits(ctx context.Context, out []Finding) {
	seen := map[string]*FindingCommit{}
	for i := range out {
		if i >= provenanceCap {
			return
		}
		path := out[i].Path
		if out[i].Type == FindingVersionChanged {
			// A version lives in Configer's own registry, so the commit that
			// moved it is the one that touched that file.
			path = ".configer/instances.yaml"
		}
		key := strings.TrimSuffix(path, "/")
		if c, ok := seen[key]; ok {
			out[i].Commit = c
			continue
		}
		commits, err := s.Backend.Log(ctx, key, 1)
		if err != nil || len(commits) == 0 {
			seen[key] = nil
			continue
		}
		c := commits[0]
		fc := &FindingCommit{SHA: c.SHA, Short: c.Short, Author: c.Author, Date: c.Date, Message: c.Message}
		seen[key] = fc
		out[i].Commit = fc
	}
}

// underAny reports whether a path sits inside one of the folder prefixes.
func underAny(path string, folders []string) bool {
	for _, f := range folders {
		f = strings.TrimSuffix(f, "/")
		if f != "" && (path == f || strings.HasPrefix(path, f+"/")) {
			return true
		}
	}
	return false
}

// folderIgnored reports whether an ignore rule covers a folder: the rule names
// the folder itself, or names files inside it.
func folderIgnored(folder string, patterns []string) bool {
	for _, p := range patterns {
		p = strings.TrimSuffix(filepath.ToSlash(p), "/")
		if p == folder || strings.HasPrefix(p, folder+"/") {
			return true
		}
		if ok, _ := filepath.Match(p, folder); ok {
			return true
		}
	}
	return false
}

// ackFindings marks everything up to HEAD as seen.
//
// @Summary     Acknowledge findings
// @Description Mark all repository findings up to HEAD as seen, so they stop surfacing. Software versions are re-baselined at the same time, so only later moves read as news. A `new_instance` finding survives being acknowledged: a folder nobody manages is a state, not an event, and it clears by managing the instance or by an ignore rule.
// @Tags        Import & reconcile
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Failure     500 {object} APIError
// @Security    CookieSession
// @Router      /api/repo/findings/ack [post]
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
	p, _ := s.load()
	s.baselineVersions(p)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ackSha": head})
}
