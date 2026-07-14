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
install: ## Install all dependencies (Go modules + npm)
	cd $(BACKEND) && go mod download
	cd $(FRONTEND) && npm install

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

.PHONY: build
build: ## Build the backend binary + frontend production bundle
	cd $(BACKEND) && go build -o bin/configer ./cmd/configer
	cd $(FRONTEND) && npm run build

.PHONY: test
test: ## Run backend tests + frontend typecheck
	cd $(BACKEND) && go test ./...
	cd $(FRONTEND) && npx tsc --noEmit

.PHONY: lint
lint: ## go vet + ESLint + TypeScript typecheck
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
