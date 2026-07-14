package api

import (
	_ "embed"
	"net/http"

	swgui "github.com/swaggest/swgui/v3emb"
)

// The OpenAPI spec is embedded so it ships with the binary and is served from
// the API itself: the raw document at /api/openapi.yaml and an interactive
// Swagger UI at /api/docs. The Swagger UI assets are embedded too (swgui), so
// the docs page works fully offline / air-gapped, consistent with the rest of
// the app. Edit backend/internal/api/openapi.yaml when endpoints change.
//
//go:embed openapi.yaml
var openAPISpec []byte

// swaggerHandler serves the embedded Swagger UI pointed at our local spec.
var swaggerHandler = swgui.NewHandler("Configer API", "/api/openapi.yaml", "/api/docs")

func serveOpenAPISpec(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/yaml")
	_, _ = w.Write(openAPISpec)
}
