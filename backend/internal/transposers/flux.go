// Package transposers holds built-in Transposer plugins that synthesize output
// artifacts from resolved configuration. These outputs need not exist in the
// source repo; they are generated into generated/<instance>/.
package transposers

import (
	"fmt"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
)

// FluxTransposer is an example generator that synthesizes a Flux HelmRelease
// manifest from the resolved parameters of an instance. It demonstrates the
// plug-and-play "transpose config into another artifact" use case: the
// HelmRelease does not exist in the source repository.
type FluxTransposer struct{}

func (FluxTransposer) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID:          "builtin.flux",
		Name:        "Flux HelmRelease Generator",
		Version:     "1.0.0",
		Kind:        plugin.KindTransposer,
		Description: "Generates a Flux HelmRelease manifest from resolved parameters.",
	}
}

// Generate emits generated/<instance>/flux/helmrelease.yaml.
func (FluxTransposer) Generate(ctx plugin.GenContext) ([]plugin.OutputFile, error) {
	// Deterministic ordering so re-renders are byte-stable (avoids spurious diffs).
	ids := make([]string, 0, len(ctx.Values))
	for id := range ctx.Values {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	var b strings.Builder
	b.WriteString("apiVersion: helm.toolkit.fluxcd.io/v2\n")
	b.WriteString("kind: HelmRelease\n")
	b.WriteString("metadata:\n")
	fmt.Fprintf(&b, "  name: %s\n", ctx.Instance.Name)
	if ctx.Instance.Environment != "" {
		fmt.Fprintf(&b, "  namespace: %s\n", ctx.Instance.Environment)
	}
	b.WriteString("spec:\n")
	b.WriteString("  interval: 5m\n")
	b.WriteString("  values:\n")
	for _, id := range ids {
		p, ok := ctx.Params[id]
		if !ok || p.Secret { // never render secret values into plaintext artifacts
			continue
		}
		fmt.Fprintf(&b, "    %s: %s\n", p.Name, scalar(ctx.Values[id]))
	}

	return []plugin.OutputFile{{
		Path:    "flux/helmrelease.yaml",
		Content: []byte(b.String()),
	}}, nil
}

func scalar(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return fmt.Sprintf("%v", v)
	}
}

// Register adds the built-in transposers to the registry.
func Register(reg *plugin.Registry) {
	reg.RegisterTransposer(FluxTransposer{})
}
