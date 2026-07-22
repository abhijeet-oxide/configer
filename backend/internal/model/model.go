// Package model defines the core domain types for Configer's write-back-native
// model: the repository's own configuration files are the single source of
// truth for VALUES, and the .configer/ folder holds METADATA ONLY. The types
// map 1:1 to the YAML artifacts stored in a managed repository:
//
//	.configer/application.yaml -> Application (name, layout, description)
//	.configer/parameters.yaml  -> Catalog     (parameter metadata + file bindings)
//	.configer/instances.yaml   -> InstanceRegistry (instance metadata + folder binding)
//
// Editing a value in the UI writes back into the bound real file; no value is
// ever stored under .configer/ and no artifact is generated.
package model

import "strings"

// Application identifies a managed application within a repository
// (.configer/application.yaml): its display name, the detected repository
// layout, and a human description.
type Application struct {
	APIVersion  string `yaml:"apiVersion" json:"apiVersion"`
	Kind        string `yaml:"kind" json:"kind"`
	Name        string `yaml:"name" json:"name"`
	Description string `yaml:"description,omitempty" json:"description,omitempty"`
	// Layout names the repository convention the layout adapter interprets:
	// "plain-folders", "kustomize", or "kpt".
	Layout string `yaml:"layout,omitempty" json:"layout,omitempty"`
	// Metadata holds free-form key/value details the user attaches to the
	// application (owner, team, ticket queue…). Stored in Git with the rest
	// of the application identity; never interpreted by Configer.
	Metadata map[string]string `yaml:"metadata,omitempty" json:"metadata,omitempty"`
}

// Scope declares how widely an edit to a parameter lands. An instance-scoped
// parameter is bound inside each instance's own folder, so a cell edit touches
// one instance. A global parameter is bound in a shared (base-layer) file every
// instance reads, so an edit applies to all of them.
type Scope string

const (
	ScopeInstance Scope = "instance"
	ScopeGlobal   Scope = "global"
)

// Layer identifies which precedence layer supplied a resolved value: the
// parameter's declared default (metadata), a shared base file, or the
// instance's own files. Later layers win.
const (
	LayerDefault  = "default"
	LayerDerived  = "derived"
	LayerBase     = "base"
	LayerInstance = "instance"
)

// LayerOrder is the read precedence, lowest to highest.
var LayerOrder = []string{LayerBase, LayerInstance}

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
	TypeIPv6    ParamType = "ipv6"
	TypeCIDR    ParamType = "cidr"
	// TypeHostname / TypePort / TypeEmail / TypeURL / TypeMAC are common
	// operational scalar types. They validate through the same checkType path
	// (and compose as list element types), giving lists like "list of ipv6" or
	// "list of hostname" real per-entry validation.
	TypeHostname ParamType = "hostname"
	TypePort     ParamType = "port"
	TypeEmail    ParamType = "email"
	TypeURL      ParamType = "url"
	TypeMAC      ParamType = "mac"
	// TypeCPU / TypeMemory are Kubernetes resource quantities: CPU in cores or
	// millicores ("500m", "2"), memory/storage as a binary or decimal SI byte
	// quantity ("256Mi", "1Gi", "512M"). They validate the format AND that the
	// amount is positive (a request or limit of zero or negative is invalid).
	TypeCPU    ParamType = "cpu"
	TypeMemory ParamType = "memory"
	// TypeDuration is a unit-suffixed duration string ("500ms", "30s", "5m").
	TypeDuration ParamType = "duration"
	// TypePercentage is an integer percentage with a trailing "%" ("75%").
	TypePercentage ParamType = "percentage"
	// TypeList holds an ordered collection; ItemType declares the element
	// type. Instances may hold different lengths: this is how one instance
	// carries 1 NTP server and another 10.
	TypeList ParamType = "list"
)

// Catalog is the parameter metadata model (.configer/parameters.yaml). It
// describes every managed parameter - where it lives in the real files, its
// type, validation rules, and lifecycle - but never its values.
type Catalog struct {
	APIVersion string      `yaml:"apiVersion" json:"apiVersion"`
	Kind       string      `yaml:"kind" json:"kind"`
	Parameters []Parameter `yaml:"parameters" json:"parameters"`
}

// Parameter describes a single managed configuration parameter.
type Parameter struct {
	ID          string    `yaml:"id" json:"id"`
	Name        string    `yaml:"name" json:"name"`
	DisplayName string    `yaml:"displayName,omitempty" json:"displayName,omitempty"`
	Description string    `yaml:"description,omitempty" json:"description,omitempty"`
	Category    string    `yaml:"category" json:"category"`
	Type        ParamType `yaml:"type" json:"type"`
	// ItemType is the element type when Type is "list".
	ItemType ParamType `yaml:"itemType,omitempty" json:"itemType,omitempty"`
	Scope    Scope     `yaml:"scope" json:"scope"`
	Secret   bool      `yaml:"secret" json:"secret"`
	// Bindings are the real-file locations this parameter's value lives at.
	// A deduplicated parameter (the same logical setting appearing in several
	// files) carries one binding per location; an edit fans out to all of
	// them. A design-phase parameter has no bindings yet.
	Bindings   []Binding  `yaml:"bindings,omitempty" json:"bindings,omitempty"`
	Validation Validation `yaml:"validation,omitempty" json:"validation,omitempty"`
	// Default is metadata: the value shown (and written on first set) when no
	// bound file carries the key. It is never rendered anywhere by itself.
	Default any `yaml:"default,omitempty" json:"default,omitempty"`
	// Derived, when set, is a computed default expressed in terms of another
	// parameter: "{other-id}" copies that parameter's effective value for the
	// same instance, optionally with an integer offset ("{other-id}+1"). It is
	// resolved read-only (never written) and any real file value overrides it,
	// so it stays true to the write-back model: a suggestion, not a stored value.
	Derived string `yaml:"derived,omitempty" json:"derived,omitempty"`
	// Source, when set, maps this parameter to a key in an external source
	// (see .configer/sources.yaml). The source's value is never applied
	// silently: it surfaces as an "incoming change" the reviewer accepts into a
	// draft, so the write-back model stays intact (a repo file value is only
	// changed by a reviewed commit). Analogous to Derived, but the value comes
	// from another system (another Git repo, a secret store) instead of another
	// parameter.
	Source *SourceRef `yaml:"source,omitempty" json:"source,omitempty"`
	// VersionIntroduced/Deprecated drive version-aware cell state in the grid.
	VersionIntroduced string   `yaml:"versionIntroduced,omitempty" json:"versionIntroduced,omitempty"`
	VersionDeprecated string   `yaml:"versionDeprecated,omitempty" json:"versionDeprecated,omitempty"`
	DependsOn         []string `yaml:"dependsOn,omitempty" json:"dependsOn,omitempty"`
	// Observed carries the value discovery read from each instance's files
	// (instance name -> value), so the onboarding proposal can preview the grid.
	// It is display-only: never persisted to .configer (yaml:"-"), only carried
	// through the discovery JSON.
	Observed map[string]any `yaml:"-" json:"observed,omitempty"`
}

// Binding maps a parameter to one location inside the repository's own files.
// Path is a dotted path for YAML/JSON ("$.network.service.ip") and an XPath
// for XML ("/network/service/ip").
//
// File may contain the template tokens "{folder}" (the instance's folder,
// e.g. "instances/prod-us-east") and "{instance}" (the instance name); a
// templated binding lives on the instance layer, one file per instance. A
// literal file is shared and lives on the base layer.
type Binding struct {
	File   string `yaml:"file" json:"file"`
	Path   string `yaml:"path" json:"path"`
	Format string `yaml:"format,omitempty" json:"format,omitempty"` // yaml | json | xml
	// Layer overrides the inferred precedence layer ("base" or "instance").
	Layer string `yaml:"layer,omitempty" json:"layer,omitempty"`
	// Line is the 1-based source line the value lives on, for display in the
	// onboarding proposal. It is NEVER persisted (line numbers drift), only
	// carried through the discovery JSON - hence yaml:"-".
	Line int `yaml:"-" json:"line,omitempty"`
}

// EffectiveLayer returns the binding's precedence layer: an explicit Layer
// wins; otherwise a templated file is instance-layer and a literal file base.
func (b Binding) EffectiveLayer() string {
	if b.Layer != "" {
		return b.Layer
	}
	if strings.Contains(b.File, "{folder}") || strings.Contains(b.File, "{instance}") {
		return LayerInstance
	}
	return LayerBase
}

// ForInstance expands the binding's file template for one instance.
func (b Binding) ForInstance(inst Instance) Binding {
	out := b
	out.File = strings.ReplaceAll(out.File, "{folder}", inst.FolderOrDefault())
	out.File = strings.ReplaceAll(out.File, "{instance}", inst.Name)
	return out
}

// BindingsOn returns the parameter's bindings on one precedence layer,
// expanded for the given instance, in declaration order.
func (p Parameter) BindingsOn(layer string, inst Instance) []Binding {
	var out []Binding
	for _, b := range p.Bindings {
		if b.EffectiveLayer() == layer {
			out = append(out, b.ForInstance(inst))
		}
	}
	return out
}

// Validation holds the rules derived from imported schemas, chosen from the
// predefined rule library (Preset), or entered by the user. Empty fields are
// ignored. Explicit fields apply on top of the referenced preset.
type Validation struct {
	Required  bool     `yaml:"required,omitempty" json:"required,omitempty"`
	Pattern   string   `yaml:"pattern,omitempty" json:"pattern,omitempty"`
	Enum      []string `yaml:"enum,omitempty" json:"enum,omitempty"`
	Min       *float64 `yaml:"min,omitempty" json:"min,omitempty"`
	Max       *float64 `yaml:"max,omitempty" json:"max,omitempty"`
	MinLength *int     `yaml:"minLength,omitempty" json:"minLength,omitempty"`
	MaxLength *int     `yaml:"maxLength,omitempty" json:"maxLength,omitempty"`
	MinItems  *int     `yaml:"minItems,omitempty" json:"minItems,omitempty"`
	MaxItems  *int     `yaml:"maxItems,omitempty" json:"maxItems,omitempty"`
	Preset    string   `yaml:"preset,omitempty" json:"preset,omitempty"` // id of a predefined rule
	SchemaRef string   `yaml:"schemaRef,omitempty" json:"schemaRef,omitempty"`
	// AtLeast / AtMost name another parameter (by id) whose effective value at
	// the same instance bounds this one: a resource limit must be AtLeast its
	// request, a request AtMost its limit. The comparison is quantity-aware
	// (CPU millicores, memory bytes, otherwise numeric), so "1" >= "500m" and
	// "1Gi" >= "512Mi" compare correctly. Enforced on write when the related
	// parameter can be resolved.
	AtLeast string `yaml:"atLeast,omitempty" json:"atLeast,omitempty"`
	AtMost  string `yaml:"atMost,omitempty" json:"atMost,omitempty"`
}

// InstanceRegistry is the central instance catalog (.configer/instances.yaml).
// It answers "which instance is at which version, in which region/zone/env,
// and which folder in the repository is it bound to".
type InstanceRegistry struct {
	APIVersion string     `yaml:"apiVersion" json:"apiVersion"`
	Kind       string     `yaml:"kind" json:"kind"`
	Instances  []Instance `yaml:"instances" json:"instances"`
}

// Instance is a deployment target: one column in the grid, bound to one
// folder in the repository (its files hold the instance's values).
type Instance struct {
	Name string `yaml:"name" json:"name"`
	// Folder is the instance's directory in the repository, relative to the
	// root (e.g. "instances/prod-us-east" or "overlays/prod"). Template
	// bindings expand "{folder}" to this value.
	Folder          string            `yaml:"folder,omitempty" json:"folder,omitempty"`
	Environment     string            `yaml:"environment,omitempty" json:"environment,omitempty"`
	Region          string            `yaml:"region,omitempty" json:"region,omitempty"`
	Zone            string            `yaml:"zone,omitempty" json:"zone,omitempty"`
	Site            string            `yaml:"site,omitempty" json:"site,omitempty"`
	// SoftwareVersion is the version IDENTIFIER (e.g. "v24.3.1") - stable, what
	// versionIntroduced/Deprecated compare against. VersionName is an optional
	// human label for the same release (e.g. "Titanium"); when empty it shows
	// as the id, so a version always reads as a name plus an id.
	SoftwareVersion string            `yaml:"softwareVersion,omitempty" json:"softwareVersion,omitempty"`
	VersionName     string            `yaml:"versionName,omitempty" json:"versionName,omitempty"`
	Labels          map[string]string `yaml:"labels,omitempty" json:"labels,omitempty"`
	Status          string            `yaml:"status,omitempty" json:"status,omitempty"` // active | draft | archived
}

// FolderOrDefault returns the instance's bound folder, defaulting to the
// plain-folders convention instances/<name>.
func (i Instance) FolderOrDefault() string {
	if i.Folder != "" {
		return i.Folder
	}
	return "instances/" + i.Name
}

// SourceRef maps one managed parameter to a single key inside an external
// source (.configer/sources.yaml). Key addresses the value within the source's
// key/value set - a dotted path for a Git config file ("$.network.admin.port"),
// a field name for a secret store. Instance, when set, targets one instance's
// value; empty means the mapping applies at the parameter's own scope.
type SourceRef struct {
	SourceID string `yaml:"sourceId" json:"sourceId"`
	Key      string `yaml:"key" json:"key"`
	Instance string `yaml:"instance,omitempty" json:"instance,omitempty"`
}

// SourceRegistry is the external-source catalog (.configer/sources.yaml): the
// systems this application pulls parameter values FROM (a different Git
// repository, a secret store). It holds connection metadata only, never
// credentials (the file is committed to Git) and never the fetched values.
type SourceRegistry struct {
	APIVersion string   `yaml:"apiVersion" json:"apiVersion"`
	Kind       string   `yaml:"kind" json:"kind"`
	Sources    []Source `yaml:"sources" json:"sources"`
}

// Source is one configured external source. Kind names the source plugin that
// interprets it ("git", "vault", ...). Config carries the plugin's NON-secret
// connection fields (a Git repo URL/branch/path, a Vault address/mount/path);
// tokens are resolved server-side from the environment, never stored here.
type Source struct {
	ID   string `yaml:"id" json:"id"`
	Name string `yaml:"name" json:"name"`
	Kind string `yaml:"kind" json:"kind"`
	// Secret marks a source that provides secret values (a secret store). Its
	// values are masked in API responses and written back as a reference, never
	// as plaintext.
	Secret bool              `yaml:"secret,omitempty" json:"secret,omitempty"`
	Config map[string]string `yaml:"config,omitempty" json:"config,omitempty"`
}
