package api

// This file holds the OpenAPI *general* information (title, version, servers,
// security schemes, shared tags). Per-endpoint documentation lives as
// annotations directly above each handler, so the spec is generated FROM the
// code and cannot silently drift: add or change a handler, re-run generation,
// and the document updates. Generation is wired through `go generate ./...`
// (and `make docs`), and CI fails if the committed spec is stale (`make
// docs-check`), so an un-regenerated change never merges.
//
// Regenerate with:
//
//	make docs           # or: go generate ./internal/api
//
// The generated artifacts live in internal/api/docs and are embedded (see
// docs.go), so the interactive Swagger UI at /api/docs and the raw spec at
// /api/openapi.json ship inside the binary and work fully offline.
//
//go:generate go run github.com/swaggo/swag/cmd/swag init --generalInfo openapi.go --dir ./,../model,../auth,../change --parseInternal --parseDepth 2 --output ./docs --outputTypes go,json,yaml --instanceName configer

// @title                      Configer API
// @version                    1.0.0
// @description                Write-back-native GitOps configuration management. Configer discovers an existing repository's layout, exposes a parameter x instance grid over the repository's OWN files, and surgically edits them; every change flows to Git as commits, branches, pull requests, and merges. `.configer/` holds metadata only.
// @description
// @description                ## Repository scoping
// @description                Every resource endpoint exists in two shapes: the unscoped `/api/...` form acts on the default (first-connected) repository for single-repo deployments and older clients, and the identical routes are available per repository under `/api/repos/{repoId}/...`. Only the unscoped forms are documented here; to target a specific repository prefix any path with `/api/repos/{repoId}`.
// @description
// @description                ## Errors
// @description                Every 4xx/5xx response uses one envelope: a stable machine-readable `code`, a human-readable `error`, a `requestId` (also returned as the `X-Request-ID` header) that correlates to server logs, and - for validation failures - a `fields` array. Branch on `code`, never on the message text.
// @description
// @description                ## Correlation
// @description                Send `X-Request-ID` to have it echoed and used as the correlation id; otherwise the server generates one. It is returned on every response.
// @termsOfService             https://github.com/abhijeet-oxide/configer
// @contact.name               Configer
// @contact.url                https://github.com/abhijeet-oxide/configer
// @license.name               See repository
// @license.url                https://github.com/abhijeet-oxide/configer
// @BasePath                   /
// @accept                     json
// @produce                    json
// @schemes                    https http
//
// @securityDefinitions.apikey CookieSession
// @in                         cookie
// @name                       configer_session
// @description                Session cookie set by the GitHub OAuth login flow (`GET /api/auth/login` -> callback). Only required when the deployment has OAuth configured; single-user deployments need no authentication.
//
// @tag.name                   Health
// @tag.description            Liveness, readiness, and deployment identity probes.
// @tag.name                   Workspace
// @tag.description            The repository portfolio: connect, list, rename, disconnect.
// @tag.name                   Onboarding
// @tag.description            Discover an application from a repository and initialize `.configer/`.
// @tag.name                   Grid & parameters
// @tag.description            The parameter x instance grid, parameter catalog, and comparison.
// @tag.name                   Instances
// @tag.description            The instance (deployment target) registry.
// @tag.name                   Editing & change requests
// @tag.description            The draft -> submit -> review -> publish change-request lifecycle.
// @tag.name                   Files
// @tag.description            Direct access to an instance's real repository files.
// @tag.name                   Import & reconcile
// @tag.description            Scan/import settings and reconcile external Git commits.
// @tag.name                   Plugins & validation
// @tag.description            Registered format plugins and the validation-rule library.
// @tag.name                   Platform
// @tag.description            Authentication, per-application roles, and the audit trail.
//
// openAPIInfo exists only to anchor the general API annotations above; swag
// reads them from this file (the --generalInfo target).
func openAPIInfo() {}
