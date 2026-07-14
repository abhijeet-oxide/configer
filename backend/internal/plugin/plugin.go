// Package plugin defines Configer's extension points and a registry for them.
// Capabilities that interpret repository content are expressed as plugins so
// new formats can be added without changing the core:
//
//   - IngestParser  : source file -> candidate parameters
//   - SchemaImporter: schema file -> validation rules
//
// Built-in plugins register themselves at startup.
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
	Path   string          `json:"path"`   // dotted path (json/yaml) or XPath (xml)
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

// Registry holds all registered plugins, grouped by kind.
type Registry struct {
	mu      sync.RWMutex
	parsers []IngestParser
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry { return &Registry{} }

// RegisterParser adds an ingest parser.
func (r *Registry) RegisterParser(p IngestParser) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.parsers = append(r.parsers, p)
}

// Parsers returns the registered ingest parsers.
func (r *Registry) Parsers() []IngestParser {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]IngestParser, len(r.parsers))
	copy(out, r.parsers)
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
	sort.Slice(ms, func(i, j int) bool {
		if ms[i].Kind != ms[j].Kind {
			return ms[i].Kind < ms[j].Kind
		}
		return ms[i].ID < ms[j].ID
	})
	return ms
}
