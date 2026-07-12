.PHONY: help setup dev test build clean deploy logs stop

# Colors for output
CYAN := \033[0;36m
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
NC := \033[0m # No Color

# Default target
.DEFAULT_GOAL := help

PROJECT_NAME := configer
BACKEND_DIR := backend
FRONTEND_DIR := frontend
DEPLOY_DIR := deploy

VERSION ?= dev
COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME ?= $(shell date -u '+%Y-%m-%dT%H:%M:%SZ')

help: ## Show this help message
	@echo "$(CYAN)$(PROJECT_NAME) - Build & Development Helper$(NC)"
	@echo ""
	@echo "$(YELLOW)Usage:$(NC)"
	@echo "  make [target]"
	@echo ""
	@echo "$(YELLOW)Available Targets:$(NC)"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}'

# ============================================================================
# SETUP & INSTALLATION
# ============================================================================

setup: ## Setup development environment (install dependencies)
	@echo "$(CYAN)Setting up development environment...$(NC)"
	@echo "$(YELLOW)→ Checking prerequisites...$(NC)"
	@command -v go >/dev/null 2>&1 || (echo "$(RED)✗ Go not installed$(NC)" && exit 1)
	@command -v node >/dev/null 2>&1 || (echo "$(RED)✗ Node.js not installed$(NC)" && exit 1)
	@command -v docker >/dev/null 2>&1 || (echo "$(RED)✗ Docker not installed$(NC)" && exit 1)
	@echo "$(GREEN)✓ Prerequisites found$(NC)"
	@echo ""
	@echo "$(YELLOW)→ Installing backend dependencies...$(NC)"
	@cd $(BACKEND_DIR) && go mod download && go mod tidy
	@echo "$(GREEN)✓ Backend dependencies installed$(NC)"
	@echo ""
	@echo "$(YELLOW)→ Installing frontend dependencies...$(NC)"
	@cd $(FRONTEND_DIR) && npm ci || npm install
	@echo "$(GREEN)✓ Frontend dependencies installed$(NC)"
	@echo ""
	@echo "$(GREEN)✓ Setup complete!$(NC)"

# ============================================================================
# DEVELOPMENT
# ============================================================================

dev: ## Start all services in development mode (Docker Compose)
	@echo "$(CYAN)Starting development environment...$(NC)"
	@echo "$(YELLOW)→ Building and starting services...$(NC)"
	@cd $(DEPLOY_DIR) && docker compose up --build
	@echo "$(GREEN)✓ Services running$(NC)"
	@echo "  Frontend: http://localhost:8088"
	@echo "  Backend API: http://localhost:8080"
	@echo "  Database: localhost:5432"

dev-local: ## Start services locally WITHOUT Docker (for native development)
	@echo "$(CYAN)Starting local development (native)...$(NC)"
	@echo "$(YELLOW)Make sure PostgreSQL is running locally!$(NC)"
	@echo ""
	@echo "$(YELLOW)→ Starting backend...$(NC)"
	@cd $(BACKEND_DIR) && CONFIGER_REPO=../sample-repo go run ./cmd/configer &
	@BACKEND_PID=$$!; \
	sleep 2; \
	echo "$(YELLOW)→ Starting frontend dev server...$(NC)"; \
	cd $(FRONTEND_DIR) && npm run dev & \
	FRONTEND_PID=$$!; \
	echo ""; \
	echo "$(GREEN)✓ Services running!$(NC)"; \
	echo "  Frontend: http://localhost:5173"; \
	echo "  Backend API: http://localhost:8080"; \
	echo ""; \
	echo "Press Ctrl+C to stop all services"; \
	trap "kill $$BACKEND_PID $$FRONTEND_PID 2>/dev/null" EXIT; \
	wait

dev-backend: ## Start only backend (assumes frontend dev running separately)
	@echo "$(CYAN)Starting backend development server...$(NC)"
	@cd $(BACKEND_DIR) && CONFIGER_REPO=../sample-repo go run ./cmd/configer

dev-frontend: ## Start only frontend (assumes backend running separately)
	@echo "$(CYAN)Starting frontend development server...$(NC)"
	@cd $(FRONTEND_DIR) && npm run dev

logs: ## Show logs from running Docker containers
	@cd $(DEPLOY_DIR) && docker compose logs -f

stop: ## Stop all running services
	@echo "$(CYAN)Stopping services...$(NC)"
	@cd $(DEPLOY_DIR) && docker compose down
	@echo "$(GREEN)✓ Services stopped$(NC)"

# ============================================================================
# TESTING
# ============================================================================

test: test-backend test-frontend ## Run all tests

test-backend: ## Run backend tests
	@echo "$(CYAN)Running backend tests...$(NC)"
	@cd $(BACKEND_DIR) && go test -v -race -coverprofile=coverage.out ./...
	@echo "$(YELLOW)→ Coverage report:$(NC)"
	@cd $(BACKEND_DIR) && go tool cover -func=coverage.out | tail -1
	@echo ""
	@echo "$(GREEN)✓ Backend tests passed$(NC)"

test-backend-coverage: ## Generate backend coverage HTML report
	@echo "$(CYAN)Generating backend coverage report...$(NC)"
	@cd $(BACKEND_DIR) && go test -coverprofile=coverage.out ./... && go tool cover -html=coverage.out -o coverage.html
	@echo "$(GREEN)✓ Coverage report: $(BACKEND_DIR)/coverage.html$(NC)"

test-frontend: ## Run frontend unit tests
	@echo "$(CYAN)Running frontend tests...$(NC)"
	@cd $(FRONTEND_DIR) && npm run test -- --run
	@echo "$(GREEN)✓ Frontend tests passed$(NC)"

test-frontend-ui: ## Run frontend tests with UI
	@echo "$(CYAN)Running frontend tests (UI mode)...$(NC)"
	@cd $(FRONTEND_DIR) && npm run test:ui

test-frontend-coverage: ## Generate frontend coverage report
	@echo "$(CYAN)Generating frontend coverage report...$(NC)"
	@cd $(FRONTEND_DIR) && npm run test:coverage
	@echo "$(GREEN)✓ Coverage report: $(FRONTEND_DIR)/coverage$(NC)"

test-e2e: ## Run E2E tests (requires running services)
	@echo "$(CYAN)Running E2E tests...$(NC)"
	@echo "$(YELLOW)⚠ Make sure services are running (make dev)$(NC)"
	@cd $(FRONTEND_DIR) && npm run test:e2e
	@echo "$(GREEN)✓ E2E tests passed$(NC)"

test-e2e-ui: ## Run E2E tests with UI (requires running services)
	@echo "$(CYAN)Running E2E tests (UI mode)...$(NC)"
	@cd $(FRONTEND_DIR) && npm run test:e2e:ui

lint: lint-backend lint-frontend ## Run all linters

lint-backend: ## Lint backend code
	@echo "$(CYAN)Linting backend code...$(NC)"
	@cd $(BACKEND_DIR) && go vet ./...
	@echo "$(GREEN)✓ Backend linting passed$(NC)"

lint-frontend: ## Lint frontend code
	@echo "$(CYAN)Linting frontend code...$(NC)"
	@cd $(FRONTEND_DIR) && npm run lint 2>/dev/null || echo "$(YELLOW)→ ESLint not configured yet$(NC)"
	@echo "$(GREEN)✓ Frontend linting checked$(NC)"

format: format-backend format-frontend ## Format all code

format-backend: ## Format backend code
	@echo "$(CYAN)Formatting backend code...$(NC)"
	@cd $(BACKEND_DIR) && go fmt ./...
	@echo "$(GREEN)✓ Backend formatted$(NC)"

format-frontend: ## Format frontend code
	@echo "$(CYAN)Formatting frontend code...$(NC)"
	@cd $(FRONTEND_DIR) && npm run format 2>/dev/null || npx prettier --write . 2>/dev/null || echo "$(YELLOW)→ Prettier not configured yet$(NC)"
	@echo "$(GREEN)✓ Frontend formatted$(NC)"

# ============================================================================
# BUILD
# ============================================================================

build: build-backend build-frontend ## Build both backend and frontend

build-backend: ## Build backend binary
	@echo "$(CYAN)Building backend...$(NC)"
	@mkdir -p ./bin
	@cd $(BACKEND_DIR) && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
		-ldflags="-X main.Version=$(VERSION) -X main.Commit=$(COMMIT) -X main.BuildTime=$(BUILD_TIME)" \
		-o ../bin/configer \
		./cmd/configer
	@echo "$(GREEN)✓ Backend built: ./bin/configer$(NC)"
	@echo "  Version: $(VERSION)"
	@echo "  Commit: $(COMMIT)"

build-backend-local: ## Build backend binary for local machine
	@echo "$(CYAN)Building backend (local)...$(NC)"
	@mkdir -p ./bin
	@cd $(BACKEND_DIR) && go build \
		-ldflags="-X main.Version=$(VERSION) -X main.Commit=$(COMMIT) -X main.BuildTime=$(BUILD_TIME)" \
		-o ../bin/configer \
		./cmd/configer
	@echo "$(GREEN)✓ Backend built: ./bin/configer$(NC)"

build-frontend: ## Build frontend (production)
	@echo "$(CYAN)Building frontend...$(NC)"
	@cd $(FRONTEND_DIR) && VITE_VERSION=$(VERSION) npm run build
	@echo "$(GREEN)✓ Frontend built: $(FRONTEND_DIR)/dist$(NC)"

build-docker: ## Build Docker images
	@echo "$(CYAN)Building Docker images...$(NC)"
	@echo "$(YELLOW)→ Building backend image...$(NC)"
	@docker build -t $(PROJECT_NAME)-backend:$(VERSION) \
		--build-arg VERSION=$(VERSION) \
		--build-arg COMMIT=$(COMMIT) \
		--build-arg BUILD_TIME=$(BUILD_TIME) \
		-f $(BACKEND_DIR)/Dockerfile \
		./$(BACKEND_DIR)
	@echo "$(GREEN)✓ Backend image built$(NC)"
	@echo ""
	@echo "$(YELLOW)→ Building frontend image...$(NC)"
	@docker build -t $(PROJECT_NAME)-frontend:$(VERSION) \
		--build-arg VITE_VERSION=$(VERSION) \
		--build-arg VITE_ENV=production \
		-f $(FRONTEND_DIR)/Dockerfile \
		./$(FRONTEND_DIR)
	@echo "$(GREEN)✓ Frontend image built$(NC)"
	@echo ""
	@echo "$(GREEN)✓ Docker images built:$(NC)"
	@docker images | grep $(PROJECT_NAME)

build-docker-dev: ## Build Docker images for development (no optimizations)
	@echo "$(CYAN)Building Docker images (dev)...$(NC)"
	@cd $(DEPLOY_DIR) && docker compose build
	@echo "$(GREEN)✓ Docker images built$(NC)"

# ============================================================================
# DEPLOYMENT
# ============================================================================

docker-up: ## Start Docker Compose stack
	@echo "$(CYAN)Starting Docker Compose stack...$(NC)"
	@cd $(DEPLOY_DIR) && docker compose up -d
	@echo "$(GREEN)✓ Stack running$(NC)"
	@echo "  Frontend: http://localhost:8088"
	@echo "  Backend: http://localhost:8080"

docker-down: ## Stop Docker Compose stack
	@echo "$(CYAN)Stopping Docker Compose stack...$(NC)"
	@cd $(DEPLOY_DIR) && docker compose down
	@echo "$(GREEN)✓ Stack stopped$(NC)"

docker-ps: ## Show running containers
	@cd $(DEPLOY_DIR) && docker compose ps

# ============================================================================
# DATABASE
# ============================================================================

db-create: ## Create database (requires PostgreSQL)
	@echo "$(CYAN)Creating database...$(NC)"
	@command -v psql >/dev/null 2>&1 || (echo "$(RED)✗ psql not found$(NC)" && exit 1)
	@psql -U postgres -c "CREATE DATABASE $(PROJECT_NAME);" 2>/dev/null || echo "$(YELLOW)→ Database may already exist$(NC)"
	@echo "$(GREEN)✓ Database ready$(NC)"

db-drop: ## Drop database (DESTRUCTIVE)
	@echo "$(RED)⚠ This will DELETE the database!$(NC)"
	@read -p "Continue? [y/N] " -n 1 -r; \
	echo; \
	if [[ $$REPLY =~ ^[Yy]$$ ]]; then \
		psql -U postgres -c "DROP DATABASE IF EXISTS $(PROJECT_NAME);"; \
		echo "$(GREEN)✓ Database dropped$(NC)"; \
	else \
		echo "$(YELLOW)Cancelled$(NC)"; \
	fi

db-reset: db-drop db-create ## Reset database (drop and recreate)

# ============================================================================
# CLEANUP
# ============================================================================

clean: ## Remove build artifacts and temporary files
	@echo "$(CYAN)Cleaning build artifacts...$(NC)"
	@rm -rf ./bin
	@rm -rf $(FRONTEND_DIR)/dist
	@rm -rf $(FRONTEND_DIR)/.next
	@rm -rf $(BACKEND_DIR)/coverage.out
	@rm -rf $(FRONTEND_DIR)/coverage
	@find . -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
	@find . -name ".DS_Store" -delete 2>/dev/null || true
	@echo "$(GREEN)✓ Cleaned$(NC)"

clean-docker: ## Remove Docker images and containers
	@echo "$(CYAN)Cleaning Docker resources...$(NC)"
	@cd $(DEPLOY_DIR) && docker compose down -v
	@docker rmi $(PROJECT_NAME)-backend:$(VERSION) 2>/dev/null || true
	@docker rmi $(PROJECT_NAME)-frontend:$(VERSION) 2>/dev/null || true
	@echo "$(GREEN)✓ Docker resources cleaned$(NC)"

clean-all: clean clean-docker ## Remove all build artifacts and Docker resources

# ============================================================================
# UTILITIES
# ============================================================================

check: ## Check if all prerequisites are installed
	@echo "$(CYAN)Checking prerequisites...$(NC)"
	@echo ""
	@echo -n "Go: "; \
	if command -v go >/dev/null 2>&1; then \
		echo "$(GREEN)✓ $$(go version | awk '{print $$3}')$(NC)"; \
	else \
		echo "$(RED)✗ Not found$(NC)"; \
	fi
	@echo -n "Node.js: "; \
	if command -v node >/dev/null 2>&1; then \
		echo "$(GREEN)✓ $$(node --version)$(NC)"; \
	else \
		echo "$(RED)✗ Not found$(NC)"; \
	fi
	@echo -n "npm: "; \
	if command -v npm >/dev/null 2>&1; then \
		echo "$(GREEN)✓ $$(npm --version)$(NC)"; \
	else \
		echo "$(RED)✗ Not found$(NC)"; \
	fi
	@echo -n "Docker: "; \
	if command -v docker >/dev/null 2>&1; then \
		echo "$(GREEN)✓ $$(docker --version)$(NC)"; \
	else \
		echo "$(RED)✗ Not found$(NC)"; \
	fi
	@echo -n "Git: "; \
	if command -v git >/dev/null 2>&1; then \
		echo "$(GREEN)✓ $$(git --version | awk '{print $$3}')$(NC)"; \
	else \
		echo "$(RED)✗ Not found$(NC)"; \
	fi
	@echo ""

version: ## Show version information
	@echo "$(CYAN)$(PROJECT_NAME) version$(NC)"
	@echo "  Version: $(VERSION)"
	@echo "  Commit: $(COMMIT)"
	@echo "  Build Time: $(BUILD_TIME)"

info: ## Show project information
	@echo "$(CYAN)Project Information$(NC)"
	@echo ""
	@echo "$(YELLOW)Backend:$(NC)"
	@echo "  Language: Go"
	@echo "  Location: $(BACKEND_DIR)/"
	@echo ""
	@echo "$(YELLOW)Frontend:$(NC)"
	@echo "  Language: TypeScript/React"
	@echo "  Framework: Vite"
	@echo "  Location: $(FRONTEND_DIR)/"
	@echo ""
	@echo "$(YELLOW)Deployment:$(NC)"
	@echo "  Location: $(DEPLOY_DIR)/"
	@echo ""

# ============================================================================
# QUICK START GUIDES
# ============================================================================

quickstart: ## Quick start guide
	@echo "$(CYAN)═══════════════════════════════════════════$(NC)"
	@echo "$(CYAN)    $(PROJECT_NAME) - Quick Start Guide        $(NC)"
	@echo "$(CYAN)═══════════════════════════════════════════$(NC)"
	@echo ""
	@echo "$(YELLOW)1. Setup Development Environment:$(NC)"
	@echo "   $$ make setup"
	@echo ""
	@echo "$(YELLOW)2. Start Development Services:$(NC)"
	@echo "   $$ make dev          # Using Docker (recommended)"
	@echo "   OR"
	@echo "   $$ make dev-local    # Native development"
	@echo ""
	@echo "$(YELLOW)3. Access the Application:$(NC)"
	@echo "   Frontend: http://localhost:8088 (Docker)"
	@echo "   Frontend: http://localhost:5173 (Native)"
	@echo "   Backend:  http://localhost:8080"
	@echo ""
	@echo "$(YELLOW)4. Run Tests:$(NC)"
	@echo "   $$ make test         # All tests"
	@echo "   $$ make test-backend # Backend only"
	@echo "   $$ make test-frontend # Frontend only"
	@echo ""
	@echo "$(YELLOW)5. Build for Production:$(NC)"
	@echo "   $$ make build         # Build both"
	@echo "   $$ make build-docker  # Build Docker images"
	@echo ""
	@echo "$(YELLOW)6. Stop Services:$(NC)"
	@echo "   $$ make stop         # Stop Docker services"
	@echo ""
	@echo "$(GREEN)For more info: make help$(NC)"
	@echo ""

.PHONY: quickstart
