# Configer developer tasks. Run `make` (or `make help`) to list everything.
# Zero-install: only needs make + go + node, which the repo already requires.
SHELL := /bin/bash
BACKEND := backend
FRONTEND := frontend
# Repository the backend serves out of the box (override: make dev CONFIGER_REPO=/path).
CONFIGER_REPO ?= ./sample-repo

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@echo "Configer - available commands:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install: ## Install all dependencies (Go modules + npm) + the git hooks
	cd $(BACKEND) && go mod download
	cd $(FRONTEND) && npm install
	@$(MAKE) --no-print-directory hooks

.PHONY: hooks
hooks: ## Point git at the repository's versioned hooks (scripts/hooks)
	@git config core.hooksPath scripts/hooks
	@chmod +x scripts/hooks/* 2>/dev/null || true
	@echo "git hooks: scripts/hooks (pre-commit keeps the OpenAPI spec in sync)"

.PHONY: dev
dev: ## Run backend (:8080) + frontend (:5173) together; Ctrl-C stops both
	@echo "Starting Configer -> backend http://localhost:8080, app http://localhost:5173"
	@trap 'kill 0' EXIT INT TERM; \
		( cd $(BACKEND) && CONFIGER_REPO=$(CONFIGER_REPO) go run ./cmd/configer ) & \
		( cd $(FRONTEND) && npm run dev ) & \
		wait

.PHONY: backend
backend: ## Run only the backend (:8080)
	cd $(BACKEND) && CONFIGER_REPO=$(CONFIGER_REPO) go run ./cmd/configer

.PHONY: frontend
frontend: ## Run only the frontend (:5173)
	cd $(FRONTEND) && npm run dev

.PHONY: docs
docs: ## Regenerate the OpenAPI spec from handler annotations
	cd $(BACKEND) && go generate ./internal/api

.PHONY: docs-check
docs-check: ## Fail if the committed OpenAPI spec is stale (CI drift guard)
	cd $(BACKEND) && go generate ./internal/api
	@if ! git diff --quiet -- $(BACKEND)/internal/api/docs; then \
		echo "" >&2; \
		echo "The committed OpenAPI spec no longer matches the handler annotations." >&2; \
		echo "It is generated AND committed (the backend serves it at /api/docs), so it" >&2; \
		echo "has to travel with the code that changed." >&2; \
		echo "" >&2; \
		echo "  Fix:      make docs && git add backend/internal/api/docs" >&2; \
		echo "  Prevent:  make hooks   # regenerates it for you on every commit" >&2; \
		echo "" >&2; \
		git --no-pager diff --stat -- $(BACKEND)/internal/api/docs >&2; \
		exit 1; \
	fi
	@echo "docs-check: spec is up to date"

.PHONY: build
build: ## Build the backend binary + frontend production bundle
	cd $(BACKEND) && go build -o bin/configer ./cmd/configer
	cd $(FRONTEND) && npm run build

.PHONY: test
test: ## Run backend tests + frontend typecheck
	cd $(BACKEND) && go test ./...
	cd $(FRONTEND) && npx tsc --noEmit

.PHONY: functional-test
functional-test: ## Scanner functional + scale tests over sample-repos/ (backend + API)
	./scripts/functional-test.sh

.PHONY: lint
lint: ## go vet + ESLint + TypeScript typecheck + no em-dashes
	./scripts/no-emdash.sh
	cd $(BACKEND) && go vet ./...
	cd $(FRONTEND) && npx eslint src && npx tsc --noEmit

.PHONY: fmt
fmt: ## Format Go code
	cd $(BACKEND) && go fmt ./...

.PHONY: tidy
tidy: ## Tidy Go module dependencies
	cd $(BACKEND) && go mod tidy

.PHONY: docker
docker: ## Run the whole stack via docker compose
	cd deploy && docker compose up --build

.PHONY: clean
clean: ## Remove build artifacts
	rm -rf $(BACKEND)/bin $(FRONTEND)/dist
