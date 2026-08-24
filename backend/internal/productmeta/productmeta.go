package productmeta

// Package productmeta reads a product DESCRIPTOR that some delivery pipelines
// ship inside an instance's own folder: a metadata directory holding a JSON
// document that names the product and the exact software release the instance
// was built from.
//
// It is a RECOGNIZED PATTERN, not a required one. A repository that does not
// carry a descriptor is not wrong and is never told about it - the instance
// simply keeps whatever version the user typed. When one IS present it is
// authoritative: it comes from the build that produced the instance, so it
// beats guessing a release out of folder names.
//
// The pattern: an instance folder holding both a configuration directory and a
// metadata directory, with a descriptor file inside the metadata directory.
// Names are matched case-insensitively, because delivery tooling spells them
// in upper case and repositories written by hand do not.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Directory and file names the pattern is spelled with, matched
// case-insensitively.
const (
	configDirName   = "configuration"
	metadataDirName = "metadata"
)

// descriptorNames are the file names inside the metadata directory that carry
// the descriptor, in the order they are tried.
var descriptorNames = []string{"product.txt", "product.json"}

// Descriptor is what a product descriptor says about one instance.
//
// Every field is optional: a descriptor that names the product but not the
// release is still useful, and half an answer beats refusing to read it.
type Descriptor struct {
	// File is the repo-relative path the descriptor was read from, so the UI
	// can say where the version came from instead of asserting it.
	File string `json:"file"`
	// Product is the stable product identifier; DisplayName is its human label.
	Product     string `json:"product,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
	// Version is the software release the instance was built from. It is what
	// selects the matching schema and what parameter version rules compare
	// against.
	Version string `json:"version,omitempty"`
	Release string `json:"release,omitempty"`
	Variant string `json:"variant,omitempty"`
	// Environment is the kind of deployment the instance is ("lab", "prod").
	Environment string `json:"environment,omitempty"`
	// Extra carries the remaining scalar fields of the descriptor verbatim, so
	// a pipeline that records something we have no field for is not silently
	// dropped.
	Extra map[string]string `json:"extra,omitempty"`
}

// raw mirrors the descriptor's own field names. Only scalars are read: an
// artifact inventory can run to thousands of entries and says nothing about
// how the instance is configured.
type raw struct {
	ProductName           string `json:"product_name"`
	DisplayName           string `json:"display_name"`
	Version               string `json:"version"`
	ProductVariant        string `json:"product_variant"`
	ProductVariantDisplay string `json:"product_variant_display"`
	ProductRelease        string `json:"product_release"`
	ProductReleaseVersion string `json:"product_release_version"`
	ProductReleaseDisplay string `json:"product_release_display"`
	SoftwareVersionItem   string `json:"sw_version_item"`
	CustomerID            string `json:"customer_id"`
	TenantID              string `json:"tenant_id"`
	DeploymentID          string `json:"deployment_id"`
	EnvironmentType       string `json:"envtype"`
}

// ForFolder reads the descriptor for one instance folder, if the folder is
// spelled the way the pattern requires and the descriptor parses.
//
// root is the repository root; folder is repo-relative. ok is false for every
// ordinary reason - no metadata directory, no descriptor file, not JSON - and
// none of them is an error: this is a pattern that either applies or does not.
func ForFolder(root, folder string) (Descriptor, bool) {
	dir := filepath.Join(root, filepath.FromSlash(folder))
	entries, err := os.ReadDir(dir)
	if err != nil {
		return Descriptor{}, false
	}
	var configDir, metaDir string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		switch strings.ToLower(e.Name()) {
		case configDirName:
			configDir = e.Name()
		case metadataDirName:
			metaDir = e.Name()
		}
	}
	// Both directories are what makes this the pattern rather than a folder
	// that happens to hold a file called product.txt.
	if configDir == "" || metaDir == "" {
		return Descriptor{}, false
	}

	metaEntries, err := os.ReadDir(filepath.Join(dir, metaDir))
	if err != nil {
		return Descriptor{}, false
	}
	for _, want := range descriptorNames {
		for _, e := range metaEntries {
			if e.IsDir() || !strings.EqualFold(e.Name(), want) {
				continue
			}
			rel := path3(folder, metaDir, e.Name())
			d, ok := parse(filepath.Join(dir, metaDir, e.Name()))
			if !ok {
				continue
			}
			d.File = rel
			return d, true
		}
	}
	return Descriptor{}, false
}

// parse reads one descriptor file.
func parse(abs string) (Descriptor, bool) {
	content, err := os.ReadFile(abs)
	if err != nil {
		return Descriptor{}, false
	}
	var r raw
	if json.Unmarshal(content, &r) != nil {
		return Descriptor{}, false
	}
	d := Descriptor{
		Product:     strings.TrimSpace(r.ProductName),
		DisplayName: strings.TrimSpace(r.DisplayName),
		Version:     strings.TrimSpace(r.Version),
		Release:     firstNonEmpty(r.ProductReleaseVersion, r.ProductRelease, r.ProductReleaseDisplay),
		Variant:     firstNonEmpty(r.ProductVariantDisplay, r.ProductVariant),
		Environment: strings.TrimSpace(r.EnvironmentType),
	}
	if d.Version == "" {
		d.Version = d.Release
	}
	// A descriptor that names nothing we can use is not a descriptor.
	if d.Product == "" && d.DisplayName == "" && d.Version == "" {
		return Descriptor{}, false
	}
	d.Extra = map[string]string{}
	for k, v := range map[string]string{
		"softwareItem": r.SoftwareVersionItem,
		"customerId":   r.CustomerID,
		"tenantId":     r.TenantID,
		"deploymentId": r.DeploymentID,
	} {
		if s := strings.TrimSpace(v); s != "" {
			d.Extra[k] = s
		}
	}
	if len(d.Extra) == 0 {
		d.Extra = nil
	}
	return d, true
}

// Label returns the human name for the product, falling back to its id.
func (d Descriptor) Label() string {
	if d.DisplayName != "" {
		return d.DisplayName
	}
	return d.Product
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

func path3(a, b, c string) string {
	return strings.TrimPrefix(filepath.ToSlash(filepath.Join(a, b, c)), "./")
}
