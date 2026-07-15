package layout

import (
	"path/filepath"
	"sort"
	"strings"

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

	// Search the repository root first, then one level of nesting (a repo may
	// keep its GitOps tree under a subfolder like gitops/ or deploy/). The
	// first parent that yields at least one instance folder wins; instance
	// folders are recognized by having config files ANYWHERE in their subtree,
	// since GitOps instances nest their values several folders deep.
	prefixes := append([]string{"."}, subdirs(root)...)
	var chosenPrefix string
search:
	for _, prefix := range prefixes {
		for _, parent := range instanceParents {
			dir := filepath.Join(root, prefix, parent)
			var found []Instance
			for _, child := range subdirs(dir) {
				if !hasConfigFileDeep(filepath.Join(dir, child)) {
					continue
				}
				folder := filepath.ToSlash(filepath.Join(prefix, parent, child))
				found = append(found, Instance{
					Name:        child,
					Folder:      strings.TrimPrefix(folder, "./"),
					Environment: guessEnvironment(child),
				})
			}
			if len(found) >= 1 {
				sort.Slice(found, func(i, j int) bool { return found[i].Name < found[j].Name })
				det.Instances = found
				det.Score = 2
				where := strings.TrimPrefix(filepath.ToSlash(filepath.Join(prefix, parent)), "./")
				det.Note = "Found one folder per instance under " + where + "/."
				chosenPrefix = prefix
				break search
			}
		}
	}

	// Shared/base directories, looked for beside the instances (same prefix).
	base := chosenPrefix
	if base == "" {
		base = "."
	}
	for _, s := range sharedDirs {
		rel := strings.TrimPrefix(filepath.ToSlash(filepath.Join(base, s)), "./")
		if hasConfigFile(filepath.Join(root, base, s)) {
			det.BaseDirs = append(det.BaseDirs, rel)
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
