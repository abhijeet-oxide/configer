// Package model defines the core domain types for Configer. These types map
// 1:1 to the YAML artifacts stored in a managed Git repository:
//
//	.configer/catalog.yaml    -> Catalog       (the parameter model)
//	.configer/instances.yaml  -> InstanceRegistry
//	.configer/instances/<name>/overlay.yaml -> Overlay (sparse per-instance values)
//
// Git remains the single source of truth; these structs are the in-memory
// representation the API and services operate on.
package model

// Scope identifies the level at which a parameter value is defined. Later
// scopes in ResolutionOrder override earlier ones when computing the effective
// value shown in a grid cell.
type Scope string

const (
	ScopeDefault     Scope = "default"
	ScopeGlobal      Scope = "global"
	ScopeEnvironment Scope = "environment"
	ScopeSite        Scope = "site"
	ScopeZone        Scope = "zone"
	ScopeInstance    Scope = "instance"
)

// ResolutionOrder is the precedence order (lowest to highest) used by the
// resolver to compute a cell's effective value.
var ResolutionOrder = []Scope{
	ScopeDefault, ScopeGlobal, ScopeEnvironment, ScopeSite, ScopeZone, ScopeInstance,
}

// ParamType is the logical type of a parameter value, used for validation and
// for rendering the correct editor in the UI.
type ParamType string

const (
	TypeString  ParamType = "string"
	TypeInteger ParamType = "integer"
	TypeBoolean ParamType = "boolean"
	TypeNumber  ParamType = "number"
	TypeEnum    ParamType = "enum"
	TypeIPv4    ParamType = "ipv4"
	TypeCIDR    ParamType = "cidr"
)

// Catalog is the parameter model (.configer/catalog.yaml). It is the single
// source describing every managed parameter: where it comes from, its type,
// validation rules, and lifecycle metadata.
type Catalog struct {
	APIVersion string          `yaml:"apiVersion" json:"apiVersion"`
	Kind       string          `yaml:"kind" json:"kind"`
	Metadata   CatalogMeta     `yaml:"metadata" json:"metadata"`
	Parameters []Parameter     `yaml:"parameters" json:"parameters"`
}

type CatalogMeta struct {
	Project string `yaml:"project" json:"project"`
}

// Parameter describes a single managed configuration parameter.
type Parameter struct {
	ID          string      `yaml:"id" json:"id"`
	Name        string      `yaml:"name" json:"name"`
	DisplayName string      `yaml:"displayName,omitempty" json:"displayName,omitempty"`
	Description string      `yaml:"description,omitempty" json:"description,omitempty"`
	Category    string      `yaml:"category" json:"category"`
	Type        ParamType   `yaml:"type" json:"type"`
	Scope       Scope       `yaml:"scope" json:"scope"`
	Secret      bool        `yaml:"secret" json:"secret"`
	Source      Source      `yaml:"source" json:"source"`
	Validation  Validation  `yaml:"validation,omitempty" json:"validation,omitempty"`
	Default     any         `yaml:"default,omitempty" json:"default,omitempty"`
	// VersionIntroduced/Deprecated drive version-aware cell state in the grid.
	VersionIntroduced string   `yaml:"versionIntroduced,omitempty" json:"versionIntroduced,omitempty"`
	VersionDeprecated string   `yaml:"versionDeprecated,omitempty" json:"versionDeprecated,omitempty"`
	DependsOn         []string `yaml:"dependsOn,omitempty" json:"dependsOn,omitempty"`
}

// Source records the origin file and the path within that file (auto-detected
// during ingestion). Path is a JSONPath-like expression for JSON/YAML and an
// XPath for XML.
type Source struct {
	File   string `yaml:"file" json:"file"`
	Path   string `yaml:"path" json:"path"`
	Format string `yaml:"format" json:"format"` // yaml | json | xml
}

// Validation holds the rules derived from imported schemas or entered by the
// user. Empty fields are ignored.
type Validation struct {
	Required  bool     `yaml:"required,omitempty" json:"required,omitempty"`
	Pattern   string   `yaml:"pattern,omitempty" json:"pattern,omitempty"`
	Enum      []string `yaml:"enum,omitempty" json:"enum,omitempty"`
	Min       *float64 `yaml:"min,omitempty" json:"min,omitempty"`
	Max       *float64 `yaml:"max,omitempty" json:"max,omitempty"`
	SchemaRef string   `yaml:"schemaRef,omitempty" json:"schemaRef,omitempty"`
}

// InstanceRegistry is the central instance catalog (.configer/instances.yaml).
// It answers "which instance is at which version, in which region/zone/env".
type InstanceRegistry struct {
	APIVersion string      `yaml:"apiVersion" json:"apiVersion"`
	Kind       string      `yaml:"kind" json:"kind"`
	Metadata   CatalogMeta `yaml:"metadata" json:"metadata"`
	Instances  []Instance  `yaml:"instances" json:"instances"`
}

// Instance is a deployment target — one column in the grid.
type Instance struct {
	Name            string            `yaml:"name" json:"name"`
	Environment     string            `yaml:"environment,omitempty" json:"environment,omitempty"`
	Region          string            `yaml:"region,omitempty" json:"region,omitempty"`
	Zone            string            `yaml:"zone,omitempty" json:"zone,omitempty"`
	Site            string            `yaml:"site,omitempty" json:"site,omitempty"`
	SoftwareVersion string            `yaml:"softwareVersion,omitempty" json:"softwareVersion,omitempty"`
	Labels          map[string]string `yaml:"labels,omitempty" json:"labels,omitempty"`
	Status          string            `yaml:"status,omitempty" json:"status,omitempty"` // active | draft | deprecated
}

// Overlay holds the sparse, per-instance value overrides keyed by parameter ID
// (.configer/instances/<name>/overlay.yaml).
type Overlay struct {
	Kind     string         `yaml:"kind" json:"kind"`
	Instance string         `yaml:"instance,omitempty" json:"instance,omitempty"`
	Values   map[string]any `yaml:"values" json:"values"`
}

// ScopeOverlays holds the non-instance overlay levels (global/environment/
// site/zone). Each maps a key (e.g. environment name) to parameter values.
// The "global" level uses the single well-known key "global".
type ScopeOverlays struct {
	Global      map[string]any            `yaml:"global,omitempty" json:"global,omitempty"`
	Environment map[string]map[string]any `yaml:"environment,omitempty" json:"environment,omitempty"`
	Site        map[string]map[string]any `yaml:"site,omitempty" json:"site,omitempty"`
	Zone        map[string]map[string]any `yaml:"zone,omitempty" json:"zone,omitempty"`
}
