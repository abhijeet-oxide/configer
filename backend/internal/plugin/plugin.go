// Package plugin defines Configer's extension points and a registry for them.
// Everything the platform does to a repository is expressed as a plugin so new
// capabilities can be added without changing the core:
//
//   - IngestParser  : source file        -> candidate parameters
//   - SchemaImporter: schema file         -> validation rules
//   - Transposer    : resolved parameters -> generated output artifacts
//   - Validator     : parameter values    -> validation findings
//
// Built-in plugins register themselves at startup; per-project selection is
// driven by .configer/plugins.yaml.
package plugin

import (
	"fmt"
	"sort"
	"sync"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// Kind enumerates the plugin extension points.
type Kind string

const (
	KindIngestParser   Kind = "ingest-parser"
	KindSchemaImporter Kind = "schema-importer"
	KindTransposer     Kind = "transposer"
	KindValidator      Kind = "validator"
	KindAIProvider     Kind = "ai-provider"
)

// Manifest is the self-description every plugin exposes so it can be listed and
// configured from the UI.
type Manifest struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Kind        Kind   `json:"kind"`
	Description string `json:"description"`
}

// Candidate is a parameter discovered by an IngestParser during a scan, before
// the user promotes it into the catalog.
type Candidate struct {
	Name   string          `json:"name"`   // human/dotted name, e.g. network.service.ip
	Path   string          `json:"path"`   // JSONPath (json/yaml) or XPath (xml)
	Type   model.ParamType `json:"type"`   // inferred type
	Value  any             `json:"value"`  // value found in the source file
	File   string          `json:"file"`   // repo-relative source file
	Format string          `json:"format"` // yaml | json | xml
}

// IngestParser detects and extracts parameters from a source file format.
type IngestParser interface {
	Manifest() Manifest
	// Detect reports whether this parser handles the given file.
	Detect(path string, content []byte) bool
	// Extract pulls candidate parameters out of the file content.
	Extract(file string, content []byte) ([]Candidate, error)
}

// GenContext is the input handed to a Transposer when producing generated
// artifacts for a single instance.
type GenContext struct {
	Instance model.Instance
	// Values is the fully resolved parameter set (paramID -> effective value)
	// for this instance.
	Values map[string]any
	// Params gives access to parameter metadata (paths, source files, types).
	Params map[string]model.Parameter
	// Config is the plugin's project-level configuration block.
	Config map[string]any
}

// OutputFile is one file a Transposer wants written under generated/<instance>/.
type OutputFile struct {
	// Path is relative to generated/<instance>/.
	Path    string
	Content []byte
}

// Transposer turns resolved configuration into arbitrary output artifacts.
// Example: a Flux generator that synthesizes HelmRelease/Kustomization files
// that do not exist in the source repo but are produced from the config.
type Transposer interface {
	Manifest() Manifest
	// Generate returns the artifacts to write for this instance.
	Generate(ctx GenContext) ([]OutputFile, error)
}

// Registry holds all registered plugins, grouped by kind.
type Registry struct {
	mu       sync.RWMutex
	parsers  []IngestParser
	transpos []Transposer
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry { return &Registry{} }

// RegisterParser adds an ingest parser.
func (r *Registry) RegisterParser(p IngestParser) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.parsers = append(r.parsers, p)
}

// RegisterTransposer adds a transposer.
func (r *Registry) RegisterTransposer(t Transposer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.transpos = append(r.transpos, t)
}

// Parsers returns the registered ingest parsers.
func (r *Registry) Parsers() []IngestParser {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]IngestParser, len(r.parsers))
	copy(out, r.parsers)
	return out
}

// Transposers returns the registered transposers.
func (r *Registry) Transposers() []Transposer {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Transposer, len(r.transpos))
	copy(out, r.transpos)
	return out
}

// ParserFor returns the first parser that detects the given file, or an error.
func (r *Registry) ParserFor(path string, content []byte) (IngestParser, error) {
	for _, p := range r.Parsers() {
		if p.Detect(path, content) {
			return p, nil
		}
	}
	return nil, fmt.Errorf("no parser for file %q", path)
}

// Manifests returns the manifests of all registered plugins, sorted by kind
// then id, for display in the UI.
func (r *Registry) Manifests() []Manifest {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var ms []Manifest
	for _, p := range r.parsers {
		ms = append(ms, p.Manifest())
	}
	for _, t := range r.transpos {
		ms = append(ms, t.Manifest())
	}
	sort.Slice(ms, func(i, j int) bool {
		if ms[i].Kind != ms[j].Kind {
			return ms[i].Kind < ms[j].Kind
		}
		return ms[i].ID < ms[j].ID
	})
	return ms
}
