package recognizers

import (
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
)

// Kustomize recognizes committed `kustomize build` output.
type Kustomize struct{}

func (Kustomize) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID: "kustomize-build", Name: "kustomize build", Version: "1", Kind: plugin.KindRecognizer,
		Description: "Recognizes manifests rendered by kustomize build.",
		Icon:        "layers", Category: "Kubernetes",
	}
}

func (Kustomize) Recognize(_ string, content []byte) (plugin.Origin, bool) {
	if !strings.Contains(commentLines(content), "kustomize build") {
		return plugin.Origin{}, false
	}
	return plugin.Origin{
		ID:          "kustomize-build",
		Name:        "kustomize build",
		Regenerates: "kustomize build",
		Note:        "Re-running the build writes over this file.",
		Instead:     "Change the base or the overlay's patches instead; the build applies them.",
	}, true
}
