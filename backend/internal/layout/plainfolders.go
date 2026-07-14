package layout

import (
	"path/filepath"
	"sort"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// plainFoldersAdapter handles the vendor-neutral convention: one directory per
// instance under a well-known parent (instances/, environments/, sites/, …),
// optionally with a shared directory (shared/, common/, base/, global/) whose
// files apply to every instance. This is the safe fallback interpretation.
type plainFoldersAdapter struct{}

func (plainFoldersAdapter) Kind() string { return KindPlainFolders }

// instanceParents are directory names that conventionally group per-instance
// folders, in preference order.
var instanceParents = []string{"instances", "environments", "envs", "sites", "clusters", "stages", "regions"}

// sharedDirs are directory names whose config files form the base layer.
var sharedDirs = []string{"shared", "common", "base", "global"}

func (a plainFoldersAdapter) Detect(root string) (Detection, bool) {
	det := Detection{Layout: KindPlainFolders}

	for _, parent := range instanceParents {
		dir := filepath.Join(root, parent)
		var found []Instance
		for _, child := range subdirs(dir) {
			if !hasConfigFile(filepath.Join(dir, child)) {
				continue
			}
			found = append(found, Instance{
				Name:        child,
				Folder:      parent + "/" + child,
				Environment: guessEnvironment(child),
			})
		}
		if len(found) >= 2 {
			sort.Slice(found, func(i, j int) bool { return found[i].Name < found[j].Name })
			det.Instances = found
			det.Score = 2
			det.Note = "Found one folder per instance under " + parent + "/."
			break
		}
	}

	for _, s := range sharedDirs {
		if hasConfigFile(filepath.Join(root, s)) {
			det.BaseDirs = append(det.BaseDirs, s)
		}
	}
	if len(det.BaseDirs) > 0 && det.Note != "" {
		det.Note += " Files under " + det.BaseDirs[0] + "/ are shared by every instance."
	}

	// Always applicable as a fallback, even with zero discovered instances.
	return det, true
}

func (plainFoldersAdapter) Scaffold(root string, from model.Instance, newName string) (model.Instance, error) {
	return scaffoldByCopy(root, from, newName)
}
