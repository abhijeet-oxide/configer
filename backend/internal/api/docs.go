package api

// The OpenAPI spec is GENERATED from the handler annotations (see openapi.go)
// and embedded so it ships with the binary: the raw document is served at
// /api/openapi.json and /api/openapi.yaml, and an interactive Swagger UI at
// /api/docs. The Swagger UI assets are embedded too (swgui), so the docs page
// works fully offline / air-gapped, consistent with the rest of the app.
//
// Do NOT hand-edit docs/configer_swagger.*; edit the annotations on the
// handlers and run `make docs` (or `go generate ./internal/api`). CI runs
// `make docs-check`, which fails if the committed spec is stale, so the docs
// can never silently drift from the code.

import (
	_ "embed"
	"net/http"

	// Importing the generated docs package runs its init(), which registers
	// the spec with swaggo's registry - handy for tooling that reads it.
	_ "github.com/abhijeet-oxide/configer/backend/internal/api/docs"
	swgui "github.com/swaggest/swgui/v3emb"
)

//go:embed docs/configer_swagger.json
var openAPISpecJSON []byte

//go:embed docs/configer_swagger.yaml
var openAPISpecYAML []byte

// swaggerHandler serves the embedded Swagger UI pointed at our local spec.
var swaggerHandler = swgui.NewHandler("Configer API", "/api/openapi.json", "/api/docs")

func serveOpenAPISpecJSON(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(openAPISpecJSON)
}

func serveOpenAPISpecYAML(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/yaml")
	_, _ = w.Write(openAPISpecYAML)
}
