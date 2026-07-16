// Package writeback edits configuration values directly in the repository's
// own files - the write-back-native model where the real files remain the
// source of truth and Configer's .configer/ folder holds only metadata and
// mappings (see docs/VISION.md). Given (file, format, path, value) it reads
// the target file, sets or removes the value at the mapped location via the
// pathedit engine, and writes it back, so comments, key order and every
// unmanaged line are preserved and the resulting Git diff is minimal.
package writeback

import (
	"os"
	"path/filepath"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/pathedit"
)

// SetValue writes value at path inside root/file, creating the file and any
// intermediate structure as needed.
func SetValue(root, file, format, path string, ptype model.ParamType, value any) error {
	return apply(root, file, format, path, ptype, value, false)
}

// RemoveValue removes the value at path inside root/file, pruning now-empty
// parents so no dangling empty section is left behind.
func RemoveValue(root, file, format, path string, ptype model.ParamType) error {
	return apply(root, file, format, path, ptype, nil, true)
}

func apply(root, file, format, path string, ptype model.ParamType, value any, remove bool) error {
	full := filepath.Join(root, file)
	base, err := os.ReadFile(full)
	if err != nil && !os.IsNotExist(err) {
		return err
	}

	var out string
	if remove {
		out, err = pathedit.Remove(base, format, path, ptype)
	} else {
		out, err = pathedit.Set(base, format, path, ptype, value)
	}
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	return os.WriteFile(full, []byte(out), 0o644)
}
