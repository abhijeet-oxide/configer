package api

// Real-file access for an instance: the files inside its bound folder plus
// any shared (base-layer) files its parameters are bound to. Draft items are
// applied IN MEMORY through the pathedit engine, so previews show exactly the
// bytes a publish would commit without touching the working tree.

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/pathedit"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// FileContent is one repository file (path relative to the repo root).
type FileContent struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// instanceFiles lists the real files that make up one instance's
// configuration, with pending draft items applied in memory.
func instanceFiles(p *project.Project, instanceName string, items []change.Item) ([]FileContent, error) {
	inst, ok := p.InstanceByName(instanceName)
	if !ok {
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

// applyDraftToFile applies the draft items that land in file f (for this
// instance) onto content, in memory.
func applyDraftToFile(p *project.Project, inst model.Instance, f, content string, items []change.Item) (string, error) {
	for _, it := range items {
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
