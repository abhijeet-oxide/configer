// Package project loads and represents a Configer-managed Git working tree:
// the catalog, the instance registry, scope overlays, per-instance overlays,
// and ignore rules found under .configer/.
package project

import (
	"os"
	"path/filepath"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"gopkg.in/yaml.v3"
)

// Ignore captures selective-import rules (.configer/ignore.yaml): files and
// parameters the user chose to exclude.
type Ignore struct {
	Files      []string `yaml:"files" json:"files"`           // glob patterns
	Parameters []string `yaml:"parameters" json:"parameters"` // parameter IDs or paths
}

// Project is the in-memory view of a managed repository.
type Project struct {
	Root     string                    `json:"root"`
	Catalog  model.Catalog             `json:"catalog"`
	Registry model.InstanceRegistry    `json:"registry"`
	Scopes   model.ScopeOverlays       `json:"scopes"`
	Overlays map[string]model.Overlay  `json:"overlays"` // instance name -> overlay
	Ignore   Ignore                    `json:"ignore"`
}

func configerDir(root string) string { return filepath.Join(root, ".configer") }

// Load reads a project from a repository working tree rooted at root.
func Load(root string) (*Project, error) {
	p := &Project{Root: root, Overlays: map[string]model.Overlay{}}
	cdir := configerDir(root)

	if err := readYAML(filepath.Join(cdir, "catalog.yaml"), &p.Catalog); err != nil {
		return nil, err
	}
	if err := readYAML(filepath.Join(cdir, "instances.yaml"), &p.Registry); err != nil {
		return nil, err
	}
	// scopes.yaml and ignore.yaml are optional.
	_ = readYAMLOptional(filepath.Join(cdir, "scopes.yaml"), &p.Scopes)
	_ = readYAMLOptional(filepath.Join(cdir, "ignore.yaml"), &p.Ignore)

	for _, inst := range p.Registry.Instances {
		var ov model.Overlay
		f := filepath.Join(cdir, "instances", inst.Name, "overlay.yaml")
		if err := readYAMLOptional(f, &ov); err != nil {
			return nil, err
		}
		if ov.Values == nil {
			ov.Values = map[string]any{}
		}
		p.Overlays[inst.Name] = ov
	}
	return p, nil
}

// ParamByID returns a parameter and whether it exists.
func (p *Project) ParamByID(id string) (model.Parameter, bool) {
	for _, param := range p.Catalog.Parameters {
		if param.ID == id {
			return param, true
		}
	}
	return model.Parameter{}, false
}

// InstanceByName returns an instance and whether it exists.
func (p *Project) InstanceByName(name string) (model.Instance, bool) {
	for _, inst := range p.Registry.Instances {
		if inst.Name == name {
			return inst, true
		}
	}
	return model.Instance{}, false
}

func readYAML(path string, out any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return yaml.Unmarshal(b, out)
}

func readYAMLOptional(path string, out any) error {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return yaml.Unmarshal(b, out)
}
