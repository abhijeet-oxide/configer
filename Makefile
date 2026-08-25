# Configer developer tasks. Run `make` (or `make help`) to list everything.
# Zero-install: only needs make + go + node, which the repo already requires.
SHELL := /bin/bash
BACKEND := backend
FRONTEND := frontend
QUALITY := quality
# Repository the backend serves out of the box (override: make dev CONFIGER_REPO=/path).
CONFIGER_REPO ?= ./sample-repo
# The quality platform's own binary, and the ref changes are measured against.
CQ := ./$(QUALITY)/bin/cq
CQ_BASE ?= origin/main
CQ_VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

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
test: ## Run backend tests + frontend typecheck + quality platform tests
	cd $(BACKEND) && go test ./...
	cd $(QUALITY) && go test ./...
	cd $(FRONTEND) && npx tsc --noEmit

# ---------------------------------------------------------------------------
# Continuous Quality Platform. `cq` orchestrates the open source analyzers,
# runs only what the change can affect, and writes one report for people,
# pipelines and AI agents. See docs/cqp/.
# ---------------------------------------------------------------------------

.PHONY: cq
cq: ## Build the quality platform binary (quality/bin/cq)
	cd $(QUALITY) && go build -trimpath -ldflags "-s -w -X github.com/abhijeet-oxide/configer/quality/internal/cli.Version=$(CQ_VERSION)" -o bin/cq ./cmd/cq
	@echo "built $(QUALITY)/bin/cq $(CQ_VERSION)"

.PHONY: quality
quality: cq ## Full pull-request quality run (incremental against $(CQ_BASE))
	$(CQ) run --tier pr --base $(CQ_BASE)

.PHONY: quality-local
quality-local: cq ## Fast local loop: formatting, types, vet (target < 30s)
	$(CQ) run --tier local --fail-on warn

.PHONY: quality-precommit
quality-precommit: cq ## What a commit would be checked against (staged files only)
	$(CQ) run --tier pre-commit --staged

.PHONY: quality-main
quality-main: cq ## The full sweep, and record it as the baseline
	$(CQ) run --tier main --full --baseline

.PHONY: quality-plan
quality-plan: cq ## Say what would run, and why, without running anything
	$(CQ) plan --tier pr --base $(CQ_BASE)

.PHONY: quality-doctor
quality-doctor: cq ## Which analyzers and tools are available here, and how to install the rest
	$(CQ) doctor

.PHONY: quality-budgets
quality-budgets: cq ## List the quality gates in force
	$(CQ) budgets

.PHONY: quality-baseline
quality-baseline: cq ## Record the current state as the baseline to measure against
	$(CQ) run --tier main --full --baseline --fail-on never

.PHONY: functional-test
functional-test: ## Scanner functional + scale tests over sample-repos/ (backend + API)
	./scripts/functional-test.sh

.PHONY: lint
lint: ## go vet + ESLint + TypeScript typecheck + no em-dashes + no orphaned CSS
	./scripts/no-emdash.sh
	cd $(BACKEND) && go vet ./...
	cd $(QUALITY) && go vet ./...
	cd $(FRONTEND) && npx eslint src && npx tsc --noEmit && node src/uikit/check-styles.mjs

.PHONY: fmt
fmt: ## Format Go code
	cd $(BACKEND) && go fmt ./...
	cd $(QUALITY) && go fmt ./...

.PHONY: tidy
tidy: ## Tidy Go module dependencies
	cd $(BACKEND) && go mod tidy
	cd $(QUALITY) && go mod tidy

.PHONY: docker
docker: ## Run the whole stack via docker compose
	cd deploy && docker compose up --build

.PHONY: clean
clean: ## Remove build artifacts
	rm -rf $(QUALITY)/bin .cq
	rm -rf $(BACKEND)/bin $(FRONTEND)/dist
