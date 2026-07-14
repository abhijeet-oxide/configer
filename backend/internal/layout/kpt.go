package layout

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// kptAdapter handles kpt/KRM package variants: sibling directories each
// carrying a Kptfile are package instances of one another. kpt setter
// comments ("# kpt-set: ${name}") mark the values meant to vary per package;
// SettersIn surfaces them so discovery can name parameters after their
// setters. Scaffolding copies a package directory and renames its Kptfile
// package metadata.
type kptAdapter struct{}

func (kptAdapter) Kind() string { return KindKpt }

func (a kptAdapter) Detect(root string) (Detection, bool) {
	det := Detection{Layout: KindKpt}

	// Kptfile-bearing sibling dirs, either at the root or under one parent
	// (e.g. packages/, deploy/ or instances/).
	parents := []string{"."}
	parents = append(parents, subdirs(root)...)
	for _, parent := range parents {
		dir := filepath.Join(root, parent)
		var found []Instance
		for _, child := range subdirs(dir) {
			if !exists(filepath.Join(dir, child, "Kptfile")) {
				continue
			}
			folder := filepath.ToSlash(filepath.Join(parent, child))
			found = append(found, Instance{
				Name:        child,
				Folder:      strings.TrimPrefix(folder, "./"),
				Environment: guessEnvironment(child),
			})
		}
		if len(found) < 2 {
			continue
		}
		sort.Slice(found, func(i, j int) bool { return found[i].Name < found[j].Name })
		det.Instances = found
		det.Score = 4 // kpt is the most specific signal, priority per product
		det.Note = "kpt layout: each Kptfile package is one instance; kpt setters become parameters."
		return det, true
	}
	return det, false
}

func (kptAdapter) Scaffold(root string, from model.Instance, newName string) (model.Instance, error) {
	inst, err := scaffoldByCopy(root, from, newName)
	if err != nil {
		return model.Instance{}, err
	}
	// The Kptfile's metadata.name identifies the package: rename it so the
	// copy is a coherent package of its own.
	kpath := filepath.Join(root, inst.FolderOrDefault(), "Kptfile")
	if b, rerr := os.ReadFile(kpath); rerr == nil {
		out := strings.Replace(string(b), "name: "+from.Name, "name: "+newName, 1)
		if werr := os.WriteFile(kpath, []byte(out), 0o644); werr != nil {
			return model.Instance{}, werr
		}
	}
	return inst, nil
}

// setterRe matches a kpt setter line: `key: value # kpt-set: ${setter-name}`.
var setterRe = regexp.MustCompile(`^\s*([A-Za-z0-9_.-]+)\s*:.*#\s*kpt-set:\s*\$\{([A-Za-z0-9_.-]+)\}`)

// SettersIn scans a YAML document for kpt setter comments and returns a map
// of YAML key -> setter name. Discovery uses it to name parameters after
// their setters (the package author's declared intent).
func SettersIn(content []byte) map[string]string {
	out := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(string(content)))
	for sc.Scan() {
		if m := setterRe.FindStringSubmatch(sc.Text()); m != nil {
			out[m[1]] = m[2]
		}
	}
	return out
}
