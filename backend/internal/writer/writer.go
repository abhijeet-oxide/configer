// Package writer performs the Git-native writes: setting a (parameter,
// instance) override into the instance's sparse overlay file, and updating a
// parameter's metadata in the catalog. Both files are machine-managed YAML;
// yaml.v3 marshals map keys in sorted order, so writes are deterministic and
// produce minimal diffs.
package writer

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"gopkg.in/yaml.v3"
)

// mutateOverlay loads (or initializes) the instance overlay, applies fn, and
// persists it.
func mutateOverlay(root, instance string, fn func(*model.Overlay)) error {
	dir := filepath.Join(root, ".configer", "instances", instance)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(dir, "overlay.yaml")

	var ov model.Overlay
	if b, err := os.ReadFile(path); err == nil {
		if err := yaml.Unmarshal(b, &ov); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if ov.Values == nil {
		ov.Values = map[string]any{}
	}
	ov.Kind = "Overlay"
	ov.Instance = instance
	fn(&ov)
	return writeYAML(path, ov)
}

func dropExclusion(ov *model.Overlay, paramID string) {
	for i, id := range ov.Exclude {
		if id == paramID {
			ov.Exclude = append(ov.Exclude[:i], ov.Exclude[i+1:]...)
			return
		}
	}
}

// SetValue writes a single override into the instance overlay (clearing any
// exclusion tombstone for the parameter).
func SetValue(root, instance, paramID string, value any) error {
	return mutateOverlay(root, instance, func(ov *model.Overlay) {
		ov.Values[paramID] = value
		dropExclusion(ov, paramID)
	})
}

// ResetValue removes the instance override and any exclusion so the value
// falls back to the scope chain.
func ResetValue(root, instance, paramID string) error {
	return mutateOverlay(root, instance, func(ov *model.Overlay) {
		delete(ov.Values, paramID)
		dropExclusion(ov, paramID)
	})
}

// ExcludeValue tombstones the parameter for this instance: no value at any
// scope will render into its generated files.
func ExcludeValue(root, instance, paramID string) error {
	return mutateOverlay(root, instance, func(ov *model.Overlay) {
		delete(ov.Values, paramID)
		if !ov.Excludes(paramID) {
			ov.Exclude = append(ov.Exclude, paramID)
		}
	})
}

// SetGlobalValue writes a parameter value at the global scope
// (.configer/scopes.yaml): it applies to every instance that does not
// override it at a more specific level.
func SetGlobalValue(root, paramID string, value any) error {
	return mutateScopes(root, func(sc *model.ScopeOverlays) {
		if sc.Global == nil {
			sc.Global = map[string]any{}
		}
		sc.Global[paramID] = value
	})
}

// ResetGlobalValue removes the global-scope value so resolution falls back to
// the parameter default.
func ResetGlobalValue(root, paramID string) error {
	return mutateScopes(root, func(sc *model.ScopeOverlays) {
		delete(sc.Global, paramID)
	})
}

func mutateScopes(root string, fn func(*model.ScopeOverlays)) error {
	path := filepath.Join(root, ".configer", "scopes.yaml")
	var sc model.ScopeOverlays
	if b, err := os.ReadFile(path); err == nil {
		if err := yaml.Unmarshal(b, &sc); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	fn(&sc)
	return writeYAML(path, sc)
}

// ParamPatch is a partial update to a parameter's metadata. Nil fields are
// left unchanged. Source is patchable only as a whole (the attach/re-map
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
	Source      *model.Source
}

// UpdateParameter applies a patch to one parameter in .configer/catalog.yaml
// and returns the updated parameter.
func UpdateParameter(root, paramID string, patch ParamPatch) (model.Parameter, error) {
	path := filepath.Join(root, ".configer", "catalog.yaml")
	b, err := os.ReadFile(path)
	if err != nil {
		return model.Parameter{}, err
	}
	var cat model.Catalog
	if err := yaml.Unmarshal(b, &cat); err != nil {
		return model.Parameter{}, fmt.Errorf("parse %s: %w", path, err)
	}

	idx := -1
	for i := range cat.Parameters {
		if cat.Parameters[i].ID == paramID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return model.Parameter{}, fmt.Errorf("parameter %q not found", paramID)
	}
	if patch.Type != nil {
		cat.Parameters[idx].Type = *patch.Type
	}
	if patch.Validation != nil {
		cat.Parameters[idx].Validation = *patch.Validation
	}
	if patch.DisplayName != nil {
		cat.Parameters[idx].DisplayName = *patch.DisplayName
	}
	if patch.Description != nil {
		cat.Parameters[idx].Description = *patch.Description
	}
	if patch.Category != nil && *patch.Category != "" {
		cat.Parameters[idx].Category = *patch.Category
	}
	if patch.Scope != nil && *patch.Scope != "" {
		cat.Parameters[idx].Scope = *patch.Scope
	}
	if patch.Secret != nil {
		cat.Parameters[idx].Secret = *patch.Secret
	}
	if patch.Default != nil {
		cat.Parameters[idx].Default = *patch.Default
	}
	if patch.Source != nil {
		if patch.Source.File == "" || patch.Source.Path == "" {
			return model.Parameter{}, fmt.Errorf("attaching a parameter requires both the file and the path")
		}
		cat.Parameters[idx].Source = *patch.Source
	}

	if err := writeYAML(path, cat); err != nil {
		return model.Parameter{}, err
	}
	return cat.Parameters[idx], nil
}

// AddParameter appends a new parameter to the catalog (e.g. a user-added
// optional key that only some instances will carry).
func AddParameter(root string, param model.Parameter) error {
	path := filepath.Join(root, ".configer", "catalog.yaml")
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var cat model.Catalog
	if err := yaml.Unmarshal(b, &cat); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	for _, p := range cat.Parameters {
		if p.ID == param.ID {
			return fmt.Errorf("parameter %q already exists", param.ID)
		}
		if p.Name == param.Name {
			return fmt.Errorf("parameter named %q already exists", param.Name)
		}
	}
	cat.Parameters = append(cat.Parameters, param)
	return writeYAML(path, cat)
}

// DeleteParameter retires a parameter everywhere: it is removed from the
// catalog and stripped from every instance overlay (values and exclusions),
// so the next render drops it from all generated files.
func DeleteParameter(root, paramID string, instances []string) error {
	path := filepath.Join(root, ".configer", "catalog.yaml")
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var cat model.Catalog
	if err := yaml.Unmarshal(b, &cat); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
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
	cat.Parameters = append(cat.Parameters[:idx], cat.Parameters[idx+1:]...)
	if err := writeYAML(path, cat); err != nil {
		return err
	}
	for _, inst := range instances {
		if err := mutateOverlay(root, inst, func(ov *model.Overlay) {
			delete(ov.Values, paramID)
			dropExclusion(ov, paramID)
		}); err != nil {
			return err
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
// taken). The instance starts with no overlay: it inherits the scope chain.
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

// DeleteInstance removes an instance from the registry and deletes its overlay
// and generated output so nothing stale is left behind.
func DeleteInstance(root, name string) error {
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
		reg.Instances = append(reg.Instances[:idx], reg.Instances[idx+1:]...)
		return nil
	}); err != nil {
		return err
	}
	_ = os.RemoveAll(filepath.Join(root, ".configer", "instances", name))
	_ = os.RemoveAll(filepath.Join(root, "generated", name))
	return nil
}

// CloneInstance creates a new instance copying the source's metadata (with
// optional overrides) and its sparse overlay, so the new instance starts as a
// full copy of an existing one.
func CloneInstance(root, from, newName string, patch InstancePatch) (model.Instance, error) {
	var created model.Instance
	err := mutateRegistry(root, func(reg *model.InstanceRegistry) error {
		var src *model.Instance
		for i := range reg.Instances {
			if reg.Instances[i].Name == from {
				src = &reg.Instances[i]
			}
			if reg.Instances[i].Name == newName {
				return fmt.Errorf("instance %q already exists", newName)
			}
		}
		if src == nil {
			return fmt.Errorf("source instance %q not found", from)
		}
		clone := *src
		clone.Name = newName
		if clone.Labels != nil {
			cp := make(map[string]string, len(clone.Labels))
			for k, v := range clone.Labels {
				cp[k] = v
			}
			clone.Labels = cp
		}
		applyInstancePatch(&clone, patch)
		reg.Instances = append(reg.Instances, clone)
		created = clone
		return nil
	})
	if err != nil {
		return model.Instance{}, err
	}
	// Copy the source overlay (values + exclusions) if it exists.
	srcOverlay := filepath.Join(root, ".configer", "instances", from, "overlay.yaml")
	if b, rerr := os.ReadFile(srcOverlay); rerr == nil {
		var ov model.Overlay
		if yaml.Unmarshal(b, &ov) == nil {
			ov.Instance = newName
			dir := filepath.Join(root, ".configer", "instances", newName)
			if err := os.MkdirAll(dir, 0o755); err == nil {
				_ = writeYAML(filepath.Join(dir, "overlay.yaml"), ov)
			}
		}
	}
	return created, nil
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

func writeYAML(path string, v any) error {
	b, err := yaml.Marshal(v)
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}
