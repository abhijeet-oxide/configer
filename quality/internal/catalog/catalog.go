// Package catalog turns a directory of YAML manifests into the set of analyzers
// the orchestrator can run. It is the whole of the plugin system's loading half:
// there is no registration call, no init() side effect and no Go interface to
// implement. Drop a file in, it is a plugin.
package catalog

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
	"github.com/abhijeet-oxide/configer/quality/internal/spec"
)

// builtin is the catalog that ships with the platform. Embedding it means a
// single `cq` binary is self-sufficient: no install step, no manifest directory
// to copy onto a runner, nothing to drift.
//
//go:embed all:manifests
var builtin embed.FS

// Catalog is a loaded, validated, ordered set of analyzers.
type Catalog struct {
	Analyzers []model.Analyzer
	// Problems are manifests that failed to load. They are collected rather
	// than fatal: one malformed plugin must not take the platform down, and
	// `cq doctor` is where they are meant to be read.
	Problems []string
}

// Load reads the built-in manifests, then layers any directories the repository
// named in cq.yaml over the top. Later definitions replace earlier ones by id,
// which is how a repository retunes a shipped analyzer without forking it.
func Load(root string, cfg *spec.Config) (*Catalog, error) {
	c := &Catalog{}
	byID := map[string]model.Analyzer{}

	sub, err := fs.Sub(builtin, "manifests")
	if err != nil {
		return nil, fmt.Errorf("built-in catalog: %w", err)
	}
	c.loadFS(sub, "built-in", byID)

	for _, dir := range cfg.AnalyzerDirs {
		abs := dir
		if !filepath.IsAbs(abs) {
			abs = filepath.Join(root, dir)
		}
		if _, err := os.Stat(abs); err != nil {
			c.Problems = append(c.Problems, fmt.Sprintf("analyzerDirs: %s does not exist", dir))
			continue
		}
		c.loadFS(os.DirFS(abs), dir, byID)
	}

	for id, a := range byID {
		if ov, ok := cfg.Analyzers[id]; ok {
			a = applyOverride(a, ov)
		}
		byID[id] = a
	}

	c.Analyzers = make([]model.Analyzer, 0, len(byID))
	for _, a := range byID {
		c.Analyzers = append(c.Analyzers, a)
	}
	sort.Slice(c.Analyzers, func(i, j int) bool { return c.Analyzers[i].ID < c.Analyzers[j].ID })

	if err := c.checkDependencies(); err != nil {
		c.Problems = append(c.Problems, err.Error())
	}
	return c, nil
}

func (c *Catalog) loadFS(fsys fs.FS, origin string, byID map[string]model.Analyzer) {
	_ = fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if ext := strings.ToLower(filepath.Ext(p)); ext != ".yaml" && ext != ".yml" {
			return nil
		}
		b, err := fs.ReadFile(fsys, p)
		if err != nil {
			c.Problems = append(c.Problems, fmt.Sprintf("%s/%s: %v", origin, p, err))
			return nil
		}
		var a model.Analyzer
		if err := yaml.Unmarshal(b, &a); err != nil {
			c.Problems = append(c.Problems, fmt.Sprintf("%s/%s: %v", origin, p, err))
			return nil
		}
		a.Source = origin + "/" + p
		if err := a.Validate(); err != nil {
			c.Problems = append(c.Problems, fmt.Sprintf("%s: %v", a.Source, err))
			return nil
		}
		byID[a.ID] = a
		return nil
	})
}

func applyOverride(a model.Analyzer, ov spec.AnalyzerOverride) model.Analyzer {
	if ov.Enabled != nil {
		a.Enabled = ov.Enabled
	}
	if len(ov.Tiers) > 0 {
		a.Tiers = ov.Tiers
	}
	if ov.TimeoutSeconds > 0 {
		a.TimeoutSeconds = ov.TimeoutSeconds
	}
	if ov.Severity != "" {
		a.Defaults.Severity = ov.Severity
	}
	if len(ov.Env) > 0 {
		if a.Tool.Env == nil {
			a.Tool.Env = map[string]string{}
		}
		for k, v := range ov.Env {
			a.Tool.Env[k] = v
		}
	}
	return a
}

// checkDependencies rejects a `needs:` pointing at nothing and any cycle, both
// of which would otherwise deadlock the scheduler rather than report an error.
func (c *Catalog) checkDependencies() error {
	index := map[string]model.Analyzer{}
	for _, a := range c.Analyzers {
		index[a.ID] = a
	}
	for _, a := range c.Analyzers {
		for _, n := range a.Needs {
			if _, ok := index[n]; !ok {
				return fmt.Errorf("analyzer %q needs %q, which no manifest defines", a.ID, n)
			}
		}
	}
	const (
		white = 0
		grey  = 1
		black = 2
	)
	state := map[string]int{}
	var visit func(id string, path []string) error
	visit = func(id string, path []string) error {
		switch state[id] {
		case grey:
			return fmt.Errorf("analyzer dependency cycle: %s", strings.Join(append(path, id), " -> "))
		case black:
			return nil
		}
		state[id] = grey
		for _, n := range index[id].Needs {
			if err := visit(n, append(path, id)); err != nil {
				return err
			}
		}
		state[id] = black
		return nil
	}
	for _, a := range c.Analyzers {
		if err := visit(a.ID, nil); err != nil {
			return err
		}
	}
	return nil
}

// ByID looks an analyzer up.
func (c *Catalog) ByID(id string) (model.Analyzer, bool) {
	for _, a := range c.Analyzers {
		if a.ID == id {
			return a, true
		}
	}
	return model.Analyzer{}, false
}

// Enabled returns the analyzers a repository has not switched off.
func (c *Catalog) Enabled() []model.Analyzer {
	out := make([]model.Analyzer, 0, len(c.Analyzers))
	for _, a := range c.Analyzers {
		if a.IsEnabled() {
			out = append(out, a)
		}
	}
	return out
}
