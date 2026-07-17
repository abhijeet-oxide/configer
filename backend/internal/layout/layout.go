// Package layout interprets a repository's own convention: which directories
// are deployment instances, which files form the shared base layer, and how a
// new instance is scaffolded. Three adapters cover the common GitOps shapes -
// kpt packages, kustomize base+overlays, and plain per-instance folders - and
// detection scores them against a working tree so onboarding can propose the
// right interpretation (always user-confirmable, never silently assumed).
package layout

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// Kinds, in the product's priority order.
const (
	KindKpt          = "kpt"
	KindKustomize    = "kustomize"
	KindPlainFolders = "plain-folders"
)

// Instance is a deployment target discovered from the folder structure.
type Instance struct {
	Name        string `json:"name"`
	Folder      string `json:"folder"`
	Environment string `json:"environment,omitempty"` // guessed from the name
}

// Detection is one adapter's reading of a repository.
type Detection struct {
	Layout    string     `json:"layout"`
	Score     int        `json:"score"` // 0 = no match; higher wins
	Instances []Instance `json:"instances"`
	// BaseDirs are shared-layer directories (kustomize base/, shared/, …):
	// files in them apply to every instance.
	BaseDirs []string `json:"baseDirs,omitempty"`
	// Note explains the detection in one human sentence for the UI.
	Note string `json:"note,omitempty"`
}

// Adapter interprets one repository convention.
type Adapter interface {
	// Kind names the convention ("kpt", "kustomize", "plain-folders").
	Kind() string
	// Detect scores the working tree; ok is false when the convention does
	// not apply at all.
	Detect(root string) (Detection, bool)
	// Scaffold creates a new instance's folder following the convention,
	// copying from an existing instance, and returns the new registry entry.
	Scaffold(root string, from model.Instance, newName string) (model.Instance, error)
}

// Adapters returns every adapter in priority order.
func Adapters() []Adapter {
	return []Adapter{kptAdapter{}, kustomizeAdapter{}, plainFoldersAdapter{}}
}

// ForKind returns the adapter for a layout kind (plain-folders when unknown,
// the safe fallback).
func ForKind(kind string) Adapter {
	for _, a := range Adapters() {
		if a.Kind() == kind {
			return a
		}
	}
	return plainFoldersAdapter{}
}

// Detect runs every adapter and returns the best-scoring detection. The
// plain-folders adapter is the fallback: it always returns a (possibly empty)
// detection, so callers always get a usable answer.
func Detect(root string) Detection {
	best := Detection{Layout: KindPlainFolders}
	for _, a := range Adapters() {
		if d, ok := a.Detect(root); ok && d.Score > best.Score {
			best = d
		}
	}
	return best
}

// --- shared helpers ----------------------------------------------------------

// guessEnvironment derives an environment from an instance name.
func guessEnvironment(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "prod") || strings.Contains(n, "dr"):
		return "production"
	case strings.Contains(n, "stag") || strings.Contains(n, "preprod") || strings.Contains(n, "qa"):
		return "staging"
	case strings.Contains(n, "dev") || strings.Contains(n, "sandbox") || strings.Contains(n, "test") || strings.Contains(n, "lab"):
		return "development"
	}
	return ""
}

// hasConfigFile reports whether dir directly contains at least one
// YAML/JSON/XML file.
func hasConfigFile(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		switch strings.ToLower(filepath.Ext(e.Name())) {
		case ".yaml", ".yml", ".json", ".xml":
			return true
		}
	}
	return false
}

// hasConfigFileDeep reports whether dir contains at least one YAML/JSON/XML
// file ANYWHERE in its subtree. GitOps instances (kustomize/Flux) keep their
// values nested several folders deep (e.g. values/<component>/values.yaml), so
// a per-instance folder must be recognized by its subtree, not only its top
// level. Stops at the first hit; skips dotfolders.
func hasConfigFileDeep(dir string) bool {
	found := false
	_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != dir && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		switch strings.ToLower(filepath.Ext(d.Name())) {
		case ".yaml", ".yml", ".json", ".xml":
			found = true
			return filepath.SkipAll
		}
		return nil
	})
	return found
}

// subdirs lists the child directories of dir (empty when dir is missing).
func subdirs(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			out = append(out, e.Name())
		}
	}
	return out
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// copyTree recursively copies src to dst (regular files only). dst must not
// already exist as an instance folder.
func copyTree(src, dst string) error {
	if exists(dst) {
		return fmt.Errorf("target folder %s already exists", dst)
	}
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
}

// scaffoldByCopy is the shared scaffold implementation: copy the source
// instance's folder to a sibling folder named after the new instance.
func scaffoldByCopy(root string, from model.Instance, newName string) (model.Instance, error) {
	srcFolder := from.FolderOrDefault()
	newFolder := filepath.ToSlash(filepath.Join(filepath.Dir(srcFolder), newName))
	if err := copyTree(filepath.Join(root, srcFolder), filepath.Join(root, newFolder)); err != nil {
		return model.Instance{}, err
	}
	inst := from
	inst.Name = newName
	inst.Folder = newFolder
	if inst.Labels != nil {
		cp := make(map[string]string, len(inst.Labels))
		for k, v := range inst.Labels {
			cp[k] = v
		}
		inst.Labels = cp
	}
	return inst, nil
}
