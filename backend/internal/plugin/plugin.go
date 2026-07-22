// Package plugin defines Configer's extension points and a registry for them.
// Capabilities that interpret repository content are expressed as plugins so
// new formats and integrations can be added without changing the core:
//
//   - IngestParser   : source file -> candidate parameters
//   - SchemaImporter : schema file -> validation rules
//   - SourceProvider : external system (another Git repo, a secret store) ->
//     key/value pairs a managed parameter can be mapped to
//
// Built-in plugins register themselves at startup.
package plugin

import (
	"context"
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
	KindSource         Kind = "source"
)

// Manifest is the self-description every plugin exposes so it can be listed and
// configured from the UI.
type Manifest struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Kind        Kind   `json:"kind"`
	Description string `json:"description"`
	// Icon, Color and Category are display hints so the UI can render a plugin
	// (especially a source plugin) as a distinct, recognizable card. Icon is a
	// slug the frontend maps to a glyph; Color is a semantic/AntD color name.
	// All optional.
	Icon     string `json:"icon,omitempty"`
	Color    string `json:"color,omitempty"`
	Category string `json:"category,omitempty"`
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
	// Line is the 1-based line the value sits on in the source file (0 when
	// the format can't report one, e.g. JSON). Used for display only.
	Line int `json:"line,omitempty"`
	// AliasOf is set (to the anchor name) when this candidate was reached
	// through a YAML alias (`*anchor`) rather than an owned value. Such a
	// candidate is a MIRROR of the anchor's definition, not an independent
	// setting; discovery drops it so the anchor is managed once, at its
	// definition, and edits propagate to every alias site at render.
	AliasOf string `json:"aliasOf,omitempty"`
}

// IngestParser detects and extracts parameters from a source file format.
type IngestParser interface {
	Manifest() Manifest
	// Detect reports whether this parser handles the given file.
	Detect(path string, content []byte) bool
	// Extract pulls candidate parameters out of the file content.
	Extract(file string, content []byte) ([]Candidate, error)
}

// SourceField describes one configuration input a source plugin needs, so the
// UI can render an "Add source" form dynamically. Type steers the widget:
// "text", "branch" (a branch picker), "path" (a repo/secret path picker) or
// "password". A field marked Secret is a credential: it is resolved
// server-side from the environment and never persisted to sources.yaml.
type SourceField struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Type     string `json:"type"`
	Required bool   `json:"required,omitempty"`
	Help     string `json:"help,omitempty"`
	Secret   bool   `json:"secret,omitempty"`
}

// SourceConfig is a configured source handed to a provider at fetch time:
// Values are the source's stored connection fields (from sources.yaml) and
// Secret is the credential resolved from the environment (empty when none).
type SourceConfig struct {
	Values map[string]string
	Secret string
}

// Get returns a config value (empty when absent).
func (c SourceConfig) Get(key string) string { return c.Values[key] }

// SourceKV is one key/value pair a source exposes. For a secret source, Value
// is masked (never the plaintext) and Ref carries the reference string that is
// written back into the repository in place of the secret.
type SourceKV struct {
	Key    string          `json:"key"`
	Value  any             `json:"value"`
	Type   model.ParamType `json:"type,omitempty"`
	Secret bool            `json:"secret,omitempty"`
	Ref    string          `json:"ref,omitempty"`
}

// BrowseEntry is one selectable node in a source's picker: a folder/file in a
// Git repo, a secret path in a store. IsDir entries can be descended into.
type BrowseEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir,omitempty"`
}

// SourceProvider fetches key/value pairs from an external system so managed
// parameters can be mapped to them. Implementations live outside the core (the
// sources package) and register at startup, exactly like ingest parsers.
type SourceProvider interface {
	Manifest() Manifest
	// Fields declares the configuration inputs needed to define a source of
	// this kind (for the dynamic "Add source" form).
	Fields() []SourceField
	// Fetch returns the current key/value pairs for a configured source.
	Fetch(ctx context.Context, cfg SourceConfig) ([]SourceKV, error)
	// Browse lists selectable entries under path (for the picker). Providers
	// that cannot browse may return an empty slice.
	Browse(ctx context.Context, cfg SourceConfig, path string) ([]BrowseEntry, error)
}

// Registry holds all registered plugins, grouped by kind.
type Registry struct {
	mu      sync.RWMutex
	parsers []IngestParser
	sources []SourceProvider
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry { return &Registry{} }

// RegisterParser adds an ingest parser.
func (r *Registry) RegisterParser(p IngestParser) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.parsers = append(r.parsers, p)
}

// RegisterSource adds a source provider.
func (r *Registry) RegisterSource(p SourceProvider) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sources = append(r.sources, p)
}

// Sources returns the registered source providers.
func (r *Registry) Sources() []SourceProvider {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]SourceProvider, len(r.sources))
	copy(out, r.sources)
	return out
}

// SourceByKind returns the source provider whose manifest id equals kind, or an
// error when no provider handles it.
func (r *Registry) SourceByKind(kind string) (SourceProvider, error) {
	for _, p := range r.Sources() {
		if p.Manifest().ID == kind {
			return p, nil
		}
	}
	return nil, fmt.Errorf("no source provider for kind %q", kind)
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
	for _, p := range r.sources {
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
