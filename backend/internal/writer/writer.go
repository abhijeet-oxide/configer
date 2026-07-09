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

// SetValue writes a single override into
// .configer/instances/<instance>/overlay.yaml, creating the file if needed.
func SetValue(root, instance, paramID string, value any) error {
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
	ov.Values[paramID] = value

	return writeYAML(path, ov)
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

func writeYAML(path string, v any) error {
	b, err := yaml.Marshal(v)
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}
