// Package writer performs the .configer/ METADATA writes: parameter metadata
// in parameters.yaml, instance metadata in instances.yaml, and ignore rules.
// It never writes values — those live in the repository's own files and go
// through the writeback engine. The metadata files are machine-managed YAML;
// yaml.v3 marshals deterministically, so writes produce minimal diffs.
package writer

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/writeback"
	"gopkg.in/yaml.v3"
)

func parametersPath(root string) string {
	return filepath.Join(root, ".configer", "parameters.yaml")
}

func mutateCatalog(root string, fn func(*model.Catalog) error) error {
	path := parametersPath(root)
	var cat model.Catalog
	if b, err := os.ReadFile(path); err == nil {
		if err := yaml.Unmarshal(b, &cat); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if cat.APIVersion == "" {
		cat.APIVersion = "configer.io/v1"
	}
	if cat.Kind == "" {
		cat.Kind = "ParameterCatalog"
	}
	if err := fn(&cat); err != nil {
		return err
	}
	return writeYAML(path, cat)
}

// ParamPatch is a partial update to a parameter's metadata. Nil fields are
// left unchanged. Bindings is patchable only as a whole (the attach/re-map
// flow: completing a design-phase parameter, or re-pointing one after a file
// rename); it is never edited as free text in the UI.
type ParamPatch struct {
	Type        *model.ParamType
	Validation  *model.Validation
	DisplayName *string
	Description *string
	Category    *string
	Scope       *model.Scope
	Secret      *bool
	Default     *any
	Bindings    *[]model.Binding
}

// UpdateParameter applies a patch to one parameter in .configer/parameters.yaml
// and returns the updated parameter.
func UpdateParameter(root, paramID string, patch ParamPatch) (model.Parameter, error) {
	var out model.Parameter
	err := mutateCatalog(root, func(cat *model.Catalog) error {
		idx := -1
		for i := range cat.Parameters {
			if cat.Parameters[i].ID == paramID {
				idx = i
				break
			}
		}
		if idx < 0 {
			return fmt.Errorf("parameter %q not found", paramID)
		}
		p := &cat.Parameters[idx]
		if patch.Type != nil {
			p.Type = *patch.Type
		}
		if patch.Validation != nil {
			p.Validation = *patch.Validation
		}
		if patch.DisplayName != nil {
			p.DisplayName = *patch.DisplayName
		}
		if patch.Description != nil {
			p.Description = *patch.Description
		}
		if patch.Category != nil && *patch.Category != "" {
			p.Category = *patch.Category
		}
		if patch.Scope != nil && *patch.Scope != "" {
			p.Scope = *patch.Scope
		}
		if patch.Secret != nil {
			p.Secret = *patch.Secret
		}
		if patch.Default != nil {
			p.Default = *patch.Default
		}
		if patch.Bindings != nil {
			for _, b := range *patch.Bindings {
				if b.File == "" || b.Path == "" {
					return fmt.Errorf("attaching a parameter requires both the file and the path")
				}
			}
			p.Bindings = *patch.Bindings
		}
		out = *p
		return nil
	})
	return out, err
}

// AddParameter appends a new parameter to the catalog (e.g. a user-added
// optional key that only some instances will carry).
func AddParameter(root string, param model.Parameter) error {
	return mutateCatalog(root, func(cat *model.Catalog) error {
		for _, p := range cat.Parameters {
			if p.ID == param.ID {
				return fmt.Errorf("parameter %q already exists", param.ID)
			}
			if p.Name == param.Name {
				return fmt.Errorf("parameter named %q already exists", param.Name)
			}
		}
		cat.Parameters = append(cat.Parameters, param)
		return nil
	})
}

// DeleteParameter retires a parameter everywhere: the catalog entry is removed
// and the bound key/element is deleted from every real file it lives in, for
// every instance, so the setting disappears from the whole repository.
func DeleteParameter(root, paramID string, instances []model.Instance) error {
	var param model.Parameter
	if err := mutateCatalog(root, func(cat *model.Catalog) error {
		idx := -1
		for i := range cat.Parameters {
			if cat.Parameters[i].ID == paramID {
				idx = i
				break
			}
		}
		if idx < 0 {
			return fmt.Errorf("parameter %q not found", paramID)
		}
		param = cat.Parameters[idx]
		cat.Parameters = append(cat.Parameters[:idx], cat.Parameters[idx+1:]...)
		return nil
	}); err != nil {
		return err
	}

	// Remove the value from every bound location. Base-layer bindings are
	// shared files: remove once. Instance-layer bindings: once per instance.
	removed := map[string]bool{}
	remove := func(b model.Binding) error {
		key := b.File + "|" + b.Path
		if removed[key] {
			return nil
		}
		removed[key] = true
		return writeback.RemoveValue(root, b.File, b.Format, b.Path, param.Type)
	}
	for _, b := range param.Bindings {
		if b.EffectiveLayer() == model.LayerBase {
			if err := remove(b); err != nil {
				return fmt.Errorf("remove %s from %s: %w", paramID, b.File, err)
			}
			continue
		}
		for _, inst := range instances {
			if err := remove(b.ForInstance(inst)); err != nil {
				return fmt.Errorf("remove %s from %s: %w", paramID, b.ForInstance(inst).File, err)
			}
		}
	}
	return nil
}

// --- instance registry ----------------------------------------------------

// InstancePatch is a partial update to an instance's metadata. Nil fields are
// left unchanged; Labels replaces the whole map when non-nil.
type InstancePatch struct {
	Environment     *string
	Region          *string
	Zone            *string
	Site            *string
	SoftwareVersion *string
	Status          *string
	Labels          *map[string]string
}

// mutateRegistry loads .configer/instances.yaml, applies fn, and persists it.
func mutateRegistry(root string, fn func(*model.InstanceRegistry) error) error {
	path := filepath.Join(root, ".configer", "instances.yaml")
	var reg model.InstanceRegistry
	if b, err := os.ReadFile(path); err == nil {
		if err := yaml.Unmarshal(b, &reg); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if reg.APIVersion == "" {
		reg.APIVersion = "configer.io/v1"
	}
	if reg.Kind == "" {
		reg.Kind = "InstanceRegistry"
	}
	if err := fn(&reg); err != nil {
		return err
	}
	return writeYAML(path, reg)
}

func applyInstancePatch(inst *model.Instance, patch InstancePatch) {
	if patch.Environment != nil {
		inst.Environment = *patch.Environment
	}
	if patch.Region != nil {
		inst.Region = *patch.Region
	}
	if patch.Zone != nil {
		inst.Zone = *patch.Zone
	}
	if patch.Site != nil {
		inst.Site = *patch.Site
	}
	if patch.SoftwareVersion != nil {
		inst.SoftwareVersion = *patch.SoftwareVersion
	}
	if patch.Status != nil {
		inst.Status = *patch.Status
	}
	if patch.Labels != nil {
		inst.Labels = *patch.Labels
	}
}

// AddInstance appends a new instance to the registry (error if the name is
// taken). Scaffolding the instance's folder is the caller's concern (the
// layout adapter); the registry only records the binding.
func AddInstance(root string, inst model.Instance) error {
	return mutateRegistry(root, func(reg *model.InstanceRegistry) error {
		for _, i := range reg.Instances {
			if i.Name == inst.Name {
				return fmt.Errorf("instance %q already exists", inst.Name)
			}
		}
		if inst.Status == "" {
			inst.Status = "active"
		}
		if inst.Folder == "" {
			inst.Folder = inst.FolderOrDefault()
		}
		reg.Instances = append(reg.Instances, inst)
		return nil
	})
}

// UpdateInstance patches one instance's metadata and returns it.
func UpdateInstance(root, name string, patch InstancePatch) (model.Instance, error) {
	var out model.Instance
	err := mutateRegistry(root, func(reg *model.InstanceRegistry) error {
		for i := range reg.Instances {
			if reg.Instances[i].Name == name {
				applyInstancePatch(&reg.Instances[i], patch)
				out = reg.Instances[i]
				return nil
			}
		}
		return fmt.Errorf("instance %q not found", name)
	})
	return out, err
}

// DeleteInstance removes an instance from the registry and deletes its folder
// so nothing stale is left behind.
func DeleteInstance(root, name string) error {
	var folder string
	if err := mutateRegistry(root, func(reg *model.InstanceRegistry) error {
		idx := -1
		for i := range reg.Instances {
			if reg.Instances[i].Name == name {
				idx = i
				break
			}
		}
		if idx < 0 {
			return fmt.Errorf("instance %q not found", name)
		}
		folder = reg.Instances[idx].FolderOrDefault()
		reg.Instances = append(reg.Instances[:idx], reg.Instances[idx+1:]...)
		return nil
	}); err != nil {
		return err
	}
	if folder != "" && folder != "." && folder != "/" {
		_ = os.RemoveAll(filepath.Join(root, folder))
	}
	return nil
}

// AddIgnoreFiles appends file globs to .configer/ignore.yaml so the scan
// skips them (the import wizard's "don't import these" persistence).
func AddIgnoreFiles(root string, files []string) error {
	path := filepath.Join(root, ".configer", "ignore.yaml")
	var ig struct {
		Files      []string `yaml:"files"`
		Parameters []string `yaml:"parameters"`
	}
	if b, err := os.ReadFile(path); err == nil {
		if err := yaml.Unmarshal(b, &ig); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	have := map[string]bool{}
	for _, f := range ig.Files {
		have[f] = true
	}
	for _, f := range files {
		if !have[f] {
			ig.Files = append(ig.Files, f)
		}
	}
	return writeYAML(path, ig)
}

// WriteApplication persists .configer/application.yaml.
func WriteApplication(root string, app model.Application) error {
	if app.APIVersion == "" {
		app.APIVersion = "configer.io/v1"
	}
	if app.Kind == "" {
		app.Kind = "Application"
	}
	dir := filepath.Join(root, ".configer")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return writeYAML(filepath.Join(dir, "application.yaml"), app)
}

func writeYAML(path string, v any) error {
	b, err := yaml.Marshal(v)
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}
