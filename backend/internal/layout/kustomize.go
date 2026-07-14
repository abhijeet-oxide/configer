package layout

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// kustomizeAdapter handles the kustomize base+overlays convention: a base/
// directory with a kustomization.yaml, and an overlays/ directory whose
// children each carry a kustomization.yaml referencing the base. Each overlay
// is one instance; the base is the shared layer. Scaffolding a new instance
// copies an existing overlay directory — relative references like ../../base
// stay valid because the copy lives at the same depth.
type kustomizeAdapter struct{}

func (kustomizeAdapter) Kind() string { return KindKustomize }

func hasKustomization(dir string) bool {
	for _, name := range []string{"kustomization.yaml", "kustomization.yml", "Kustomization"} {
		if exists(filepath.Join(dir, name)) {
			return true
		}
	}
	return false
}

func (a kustomizeAdapter) Detect(root string) (Detection, bool) {
	det := Detection{Layout: KindKustomize}

	// Look for <prefix>/overlays/<name>/kustomization.yaml with a sibling
	// base/. The prefix handles repos that nest under e.g. deploy/ or k8s/.
	prefixes := []string{"."}
	prefixes = append(prefixes, subdirs(root)...)
	for _, prefix := range prefixes {
		overlaysDir := filepath.Join(root, prefix, "overlays")
		var found []Instance
		for _, child := range subdirs(overlaysDir) {
			if !hasKustomization(filepath.Join(overlaysDir, child)) {
				continue
			}
			folder := filepath.ToSlash(filepath.Join(prefix, "overlays", child))
			found = append(found, Instance{
				Name:        child,
				Folder:      strings.TrimPrefix(folder, "./"),
				Environment: guessEnvironment(child),
			})
		}
		if len(found) == 0 {
			continue
		}
		sort.Slice(found, func(i, j int) bool { return found[i].Name < found[j].Name })
		det.Instances = found
		det.Score = 3
		det.Note = "Kustomize layout: each overlay is one instance."
		baseDir := filepath.ToSlash(filepath.Join(prefix, "base"))
		baseDir = strings.TrimPrefix(baseDir, "./")
		if hasKustomization(filepath.Join(root, baseDir)) {
			det.BaseDirs = []string{baseDir}
			det.Note = "Kustomize layout: each overlay is one instance; base/ is shared by all."
		}
		return det, true
	}
	return det, false
}

func (kustomizeAdapter) Scaffold(root string, from model.Instance, newName string) (model.Instance, error) {
	inst, err := scaffoldByCopy(root, from, newName)
	if err != nil {
		return model.Instance{}, err
	}
	// Adapt nameSuffix/namePrefix-style self-references that literally carry
	// the source instance's name (a common overlay pattern), so the copy is
	// immediately coherent without a manual rename pass.
	kpath := filepath.Join(root, inst.FolderOrDefault(), "kustomization.yaml")
	if b, rerr := os.ReadFile(kpath); rerr == nil && strings.Contains(string(b), from.Name) {
		out := strings.ReplaceAll(string(b), from.Name, newName)
		if werr := os.WriteFile(kpath, []byte(out), 0o644); werr != nil {
			return model.Instance{}, werr
		}
	}
	return inst, nil
}
