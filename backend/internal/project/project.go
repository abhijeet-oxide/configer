// Package project loads and represents a Configer-managed Git working tree:
// the application identity, parameter metadata (with real-file bindings), the
// instance registry, and ignore rules found under .configer/. Values are never
// loaded from .configer/ - they live in the repository's own files and are
// read through the resolver.
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
	Root     string                 `json:"root"`
	App      model.Application      `json:"app"`
	Catalog  model.Catalog          `json:"catalog"`
	Registry model.InstanceRegistry `json:"registry"`
	Sources  model.SourceRegistry   `json:"sources"`
	Ignore   Ignore                 `json:"ignore"`
}

func configerDir(root string) string { return filepath.Join(root, ".configer") }

// Load reads a project from a repository working tree rooted at root.
func Load(root string) (*Project, error) {
	p := &Project{Root: root}
	cdir := configerDir(root)

	if err := readYAML(filepath.Join(cdir, "parameters.yaml"), &p.Catalog); err != nil {
		return nil, err
	}
	if err := readYAML(filepath.Join(cdir, "instances.yaml"), &p.Registry); err != nil {
		return nil, err
	}
	// application.yaml, ignore.yaml and sources.yaml are optional (older
	// projects may miss the application file; the folder name then names the
	// application. sources.yaml only exists once external sources are defined).
	_ = readYAMLOptional(filepath.Join(cdir, "application.yaml"), &p.App)
	_ = readYAMLOptional(filepath.Join(cdir, "ignore.yaml"), &p.Ignore)
	_ = readYAMLOptional(filepath.Join(cdir, "sources.yaml"), &p.Sources)
	if p.App.Name == "" {
		p.App.Name = filepath.Base(root)
	}
	return p, nil
}

// Name returns the application's display name.
func (p *Project) Name() string { return p.App.Name }

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

// SourceByID returns a configured external source and whether it exists.
func (p *Project) SourceByID(id string) (model.Source, bool) {
	for _, src := range p.Sources.Sources {
		if src.ID == id {
			return src, true
		}
	}
	return model.Source{}, false
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
