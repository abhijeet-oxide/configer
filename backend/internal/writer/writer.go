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

// ParamPatch is a partial update to a parameter's metadata. Nil fields are
// left unchanged.
type ParamPatch struct {
	Type       *model.ParamType
	Validation *model.Validation
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

func writeYAML(path string, v any) error {
	b, err := yaml.Marshal(v)
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}
