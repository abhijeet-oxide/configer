package writer

// External-source metadata writes (.configer/sources.yaml) and the
// parameter->source mapping (the parameter's `source:` field in
// parameters.yaml). Like the rest of writer, this touches METADATA only:
// connection details, never credentials, never fetched values.

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"gopkg.in/yaml.v3"
)

func sourcesPath(root string) string {
	return filepath.Join(root, ".configer", "sources.yaml")
}

// mutateSources reads .configer/sources.yaml, applies fn, and writes it back.
// The registry is small and machine-managed, so a deterministic whole-file
// marshal (as with the parameter catalog) keeps diffs minimal without the
// node-surgery the hand-formatted instance registry needs.
func mutateSources(root string, fn func(*model.SourceRegistry) error) error {
	path := sourcesPath(root)
	var reg model.SourceRegistry
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
		reg.Kind = "SourceRegistry"
	}
	if err := fn(&reg); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return writeYAML(path, reg)
}

// AddSource appends a new external source (error if the id is taken).
func AddSource(root string, src model.Source) error {
	return mutateSources(root, func(reg *model.SourceRegistry) error {
		for _, s := range reg.Sources {
			if s.ID == src.ID {
				return fmt.Errorf("source %q already exists", src.ID)
			}
		}
		reg.Sources = append(reg.Sources, src)
		return nil
	})
}

// SourcePatch is a partial update to a source's metadata. Nil fields are left
// unchanged; Config replaces the whole map when non-nil.
type SourcePatch struct {
	Name   *string
	Secret *bool
	Config *map[string]string
}

// UpdateSource patches one source's metadata and returns it.
func UpdateSource(root, id string, patch SourcePatch) (model.Source, error) {
	var out model.Source
	err := mutateSources(root, func(reg *model.SourceRegistry) error {
		idx := -1
		for i := range reg.Sources {
			if reg.Sources[i].ID == id {
				idx = i
				break
			}
		}
		if idx < 0 {
			return fmt.Errorf("source %q not found", id)
		}
		s := &reg.Sources[idx]
		if patch.Name != nil {
			s.Name = *patch.Name
		}
		if patch.Secret != nil {
			s.Secret = *patch.Secret
		}
		if patch.Config != nil {
			s.Config = *patch.Config
		}
		out = *s
		return nil
	})
	return out, err
}

// DeleteSource removes a source from the registry. Parameters still mapped to
// it keep their `source:` reference (dangling); the caller decides whether to
// clear those mappings.
func DeleteSource(root, id string) error {
	return mutateSources(root, func(reg *model.SourceRegistry) error {
		idx := -1
		for i := range reg.Sources {
			if reg.Sources[i].ID == id {
				idx = i
				break
			}
		}
		if idx < 0 {
			return fmt.Errorf("source %q not found", id)
		}
		reg.Sources = append(reg.Sources[:idx], reg.Sources[idx+1:]...)
		return nil
	})
}

// MapParameterSource sets (or, when ref is nil, clears) a parameter's mapping
// to an external source key. The mapping lives on the parameter in
// parameters.yaml, alongside its bindings and validation.
func MapParameterSource(root, paramID string, ref *model.SourceRef) error {
	return mutateCatalog(root, func(cat *model.Catalog) error {
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
		if ref != nil && (ref.SourceID == "" || ref.Key == "") {
			return fmt.Errorf("a source mapping requires both a source and a key")
		}
		cat.Parameters[idx].Source = ref
		return nil
	})
}
