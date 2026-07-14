# Developer Guide

A complete guide to develop, test, build, and deploy Configer locally and in production.

## Table of Contents

- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Development Workflow](#development-workflow)
- [Testing](#testing)
- [Building](#building)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)

---

## Quick Start

The **fastest way** to get started:

```bash
# 1. Clone the repository
git clone https://github.com/abhijeet-oxide/configer.git
cd configer

# 2. One command setup & run everything
make quickstart          # Shows quick start guide
make setup              # Install all dependencies
make dev                # Start all services with Docker

# Done! Open http://localhost:8088
```

**No need to navigate to different folders or run multiple commands separately!**

---

## Prerequisites

### Required
- **Docker** & **Docker Compose** ([Download](https://www.docker.com/products/docker-desktop))
- **Git** ([Download](https://git-scm.com/))

### Optional (for native development without Docker)
- **Go 1.24+** ([Download](https://golang.org/dl/))
- **Node.js 22+** ([Download](https://nodejs.org/))

### Check if you have everything:

```bash
make check
```

Expected output:
```
Checking prerequisites...

Go: ✓ go version go1.24.7
Node.js: ✓ v22.0.0
npm: ✓ 10.5.0
Docker: ✓ Docker version 27.0.0
Git: ✓ git version 2.45.2
```

---

## Setup

### One-Command Setup

```bash
make setup
```

This automatically:
- ✅ Checks all prerequisites
- ✅ Downloads Go modules
- ✅ Downloads npm packages
- ✅ Prepares the environment

### Manual Setup

If `make` is not available on Windows:

**Backend Setup:**
```bash
cd backend
go mod download
go mod tidy
```

**Frontend Setup:**
```bash
cd frontend
npm install
```

---

## Development Workflow

### Option 1: Using Docker (Recommended) 🐳

**Best for**: Most developers, consistent environment

```bash
# Start everything with one command
make dev

# In another terminal, watch logs
make logs

# Stop when done
make stop
```

What it does:
- Builds Docker images
- Starts Backend (Go) on port 8080
- Starts Frontend (React) on port 8088
- Starts PostgreSQL on port 5432
- All services auto-reload on code changes

Access:
- **Frontend**: http://localhost:8088
- **Backend API**: http://localhost:8080
- **Database**: localhost:5432

### Option 2: Native Development (No Docker) 🏃

**Best for**: Faster feedback loop, direct debugging

```bash
# Terminal 1: Start backend
make dev-backend
# Backend runs on http://localhost:8080

# Terminal 2: Start frontend
make dev-frontend
# Frontend runs on http://localhost:5173
```

Or start them together:
```bash
make dev-local
```

### Option 3: Individual Service Development

```bash
# Only backend
make dev-backend
# Only frontend
make dev-frontend
```

### Switching Between Modes

**From Docker to Native:**
```bash
make stop              # Stop Docker services
make dev-local         # Start native services
```

**From Native to Docker:**
```bash
make dev               # Start Docker services
```

---

## File Structure & Explanations

```
configer/
├── Makefile                          # 👈 START HERE - All commands
├── README.md                         # Project overview
├── DEVELOPER_GUIDE.md               # This file
├── IMPROVEMENTS.md                  # Suggested improvements
│
├── backend/                         # Go backend
│   ├── go.mod                       # Go dependencies
│   ├── go.sum                       # Dependency checksums
│   ├── Dockerfile                   # Backend Docker image
│   ├── cmd/
│   │   └── configer/                # Backend entry point
│   └── internal/                    # Backend implementation
│
├── frontend/                        # React + TypeScript frontend
│   ├── package.json                 # npm dependencies
│   ├── vite.config.ts               # Vite build config
│   ├── tsconfig.json                # TypeScript config
│   ├── Dockerfile                   # Frontend Docker image
│   ├── nginx.conf                   # Production nginx config
│   ├── src/
│   │   ├── main.tsx                 # Entry point
│   │   ├── App.tsx                  # Main component
│   │   ├── api.ts                   # API client
│   │   └── components/              # React components
│   └── dist/                        # Built files (generated)
│
├── deploy/                          # Deployment configs
│   ├── docker-compose.yml           # Local dev stack
│   └── helm/                        # Kubernetes charts (future)
│
├── sample-repo/                     # Example config repository
│   └── .configer/                   # Config model
│       ├── catalog.yaml             # Parameter definitions
│       └── instances.yaml           # Instance registry
│
├── docs/                            # Documentation
│   ├── PLAN.md                      # Future plans
│   ├── screenshot-*.png             # UI screenshots
│   └── adr/                         # Architecture decisions (future)
│
└── .github/workflows/               # CI/CD pipeline
    └── ci.yml                       # GitHub Actions config
```

---

## Testing

### Running All Tests

```bash
make test
```

### Backend Tests Only

```bash
# Run with output
make test-backend

# Generate coverage report
make test-backend-coverage
# View: backend/coverage.html
```

### Frontend Tests Only

```bash
# Run once
make test-frontend

# Run with UI
make test-frontend-ui

# Generate coverage
make test-frontend-coverage
# View: frontend/coverage/
```

### E2E Tests (Browser Testing)

```bash
# First ensure services are running
make dev

# In another terminal
make test-e2e

# Run with UI
make test-e2e-ui
```

### Watching Tests During Development

```bash
cd frontend
npm run test        # Automatically re-runs on file changes
```

---

## Building

### Build for Development

```bash
make build
```

Produces:
- `bin/configer` - Backend binary
- `frontend/dist/` - Frontend static files

### Build for Production (Local Binary)

```bash
make build-backend-local
make build-frontend

# Run locally
./bin/configer
```

### Build Docker Images

```bash
# Development images (used by docker-compose)
make build-docker-dev

# Production images
make build-docker VERSION=1.0.0

# View built images
docker images | grep configer
```

### Build Parameters

```bash
# Custom version
make build VERSION=1.0.0-alpha

# Rebuild without cache
make clean
make build
```

---

## Code Quality

### Linting

```bash
# Lint all code
make lint

# Lint backend only
make lint-backend

# Lint frontend only
make lint-frontend
```

### Code Formatting

```bash
# Format all code
make format

# Format backend
make format-backend

# Format frontend
make format-frontend
```

---

## Deployment

### Local Docker Stack

```bash
# Start
make docker-up

# Check status
make docker-ps

# View logs
make logs

# Stop
make docker-down
```

### Production Deployment

For production deployments with Kubernetes:

```bash
# 1. Build production images
make build-docker VERSION=1.0.0

# 2. Push to registry (configure first)
docker tag configer-backend:1.0.0 your-registry/configer-backend:1.0.0
docker push your-registry/configer-backend:1.0.0

# 3. Deploy with Helm (see deploy/helm/)
helm install configer ./deploy/helm/configer \
  --set backend.image.tag=1.0.0 \
  --set frontend.image.tag=1.0.0
```

---

## Database

### Create Database (PostgreSQL)

```bash
make db-create
```

### Reset Database (DESTRUCTIVE ⚠️)

```bash
make db-reset
```

### Drop Database (DESTRUCTIVE ⚠️)

```bash
make db-drop
```

---

## Cleanup

### Remove Build Artifacts

```bash
make clean
```

Removes:
- Binary files
- Built frontend
- Coverage reports
- Temporary files

### Remove Docker Resources

```bash
make clean-docker
```

Removes:
- Docker containers
- Docker images
- Docker volumes

### Remove Everything

```bash
make clean-all
```

---

## Environment Variables

### Backend Configuration

Create `.env` in `backend/`:

```env
# Server
CONFIGER_ADDR=:8080
CONFIGER_ENV=development
CONFIGER_VERSION=dev
CONFIGER_REPO=../sample-repo

# Git
CONFIGER_SYNC_SECONDS=30
CONFIGER_GIT_NAME="Configer Bot"
CONFIGER_GIT_EMAIL="configer-bot@localhost"

# GitHub (optional)
GITHUB_TOKEN=your-token-here
```

### Frontend Configuration

Create `frontend/.env.local`:

```env
VITE_API_BASE_URL=http://localhost:8080
VITE_ENV=development
VITE_VERSION=0.1.0-dev
```

Create `frontend/.env.production`:

```env
VITE_API_BASE_URL=https://api.configer.yourdomain.com
VITE_ENV=production
VITE_VERSION=0.1.0
```

---

## Common Workflows

### "I want to add a new feature"

```bash
# 1. Create feature branch
git checkout -b feature/my-feature

# 2. Start dev environment
make dev

# 3. Make changes to code

# 4. Run tests
make test

# 5. Commit and push
git add .
git commit -m "feat: add my feature"
git push origin feature/my-feature

# 6. Open Pull Request
```

### "I want to fix a bug in the backend"

```bash
# 1. Create bug branch
git checkout -b fix/bug-name

# 2. Start backend only (faster feedback)
make dev-backend

# 3. Make changes and test
make test-backend

# 4. Verify with frontend
make dev-frontend  # In another terminal

# 5. Commit and push
git add backend/
git commit -m "fix: resolve bug in backend"
git push origin fix/bug-name
```

### "I want to debug frontend in browser"

```bash
# Start with native dev (better debugging)
make dev-frontend

# Open DevTools (F12 in most browsers)
# Frontend runs on http://localhost:5173
# Changes auto-reload
```

### "I want to debug backend with logs"

```bash
# Start backend with logs
make dev-backend

# OR with Docker to see all service logs
make dev
make logs

# Filter logs
docker compose logs backend -f
```

### "I want to update dependencies"

```bash
# Backend
cd backend && go get -u ./...

# Frontend
cd frontend && npm update

# Test everything still works
make test
```

---

## Git Workflow

### Branching Strategy

```
main                    # Production-ready
├── feature/feature-name      # New features
├── fix/bug-name              # Bug fixes
└── docs/documentation        # Documentation updates

develop                 # Development (if used)
```

### Commit Message Format

```
type(scope): subject

body

footer
```

Examples:
```
feat(grid): add parameter search
fix(api): correct cache invalidation logic
docs(readme): update installation instructions
test(frontend): add grid cell tests
chore(deps): bump React to 18.3.1
```

---

## Troubleshooting

### Problem: "Command 'make' not found" on Windows

**Solution**: Install Make for Windows
- Install via Chocolatey: `choco install make`
- OR use WSL2 (Windows Subsystem for Linux)
- OR run commands manually from each directory

### Problem: "Docker daemon is not running"

**Solution**: Start Docker Desktop

```bash
# Linux
sudo systemctl start docker

# macOS
open /Applications/Docker.app

# Windows
# Click Docker Desktop in Start menu
```

### Problem: "Port 8088 is already in use"

**Solution**: Change the port

```bash
# Option 1: Stop the service using port 8088
lsof -i :8088      # Find what's using it
kill -9 <PID>      # Kill it

# Option 2: Use different port
docker run -p 8090:80 configer-frontend:latest
```

### Problem: "Node modules not found after npm install"

**Solution**: Clear and reinstall

```bash
cd frontend
rm -rf node_modules package-lock.json
npm install
```

### Problem: Backend "connection refused"

**Solution**: Ensure backend is running

```bash
# Check if backend is running
curl http://localhost:8080/api/health

# If not, start it
make dev-backend
```

### Problem: Tests failing locally but passing in CI

**Solution**: Clear cache and rebuild

```bash
make clean
make build
make test
```

### Problem: "Permission denied" errors on Linux/Mac

**Solution**: Grant execute permissions

```bash
chmod +x ./bin/configer
# Or use sudo with make
sudo make dev
```

### Need Help?

```bash
# Show this guide
make help

# Show quick start
make quickstart

# Show version info
make version

# Check your setup
make check
```

---

## Architecture

### High-Level Overview

```
┌─────────────────────────────────────────────────────┐
│                  Browser                            │
└──────────────────────┬──────────────────────────────┘
                       │
                       │ HTTP/REST
                       ▼
┌──────────────────────────────────────────────────────┐
│         Frontend (React + TypeScript)                │
│                   Vite                               │
│  - Grid Editor                                       │
│  - Change Requests                                   │
│  - Import Wizard                                     │
│  - Dashboard                                         │
└──────────────────────┬───────────────────────────────┘
                       │
                       │ /api/...
                       ▼
┌──────────────────────────────────────────────────────┐
│          Backend (Go + REST API)                     │
│                                                      │
│  - Parameter Model                                   │
│  - Grid Resolution                                   │
│  - Git Integration                                   │
│  - Change Request Pipeline                          │
└──────────────────────┬───────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
    ┌────────┐  ┌────────────┐  ┌──────────┐
    │ Git    │  │ PostgreSQL │  │ Plugins  │
    │ Repo   │  │ (Metadata) │  │ (YAML,   │
    │        │  │            │  │ JSON,XML)│
    └────────┘  └────────────┘  └──────────┘
```

### Directory Purposes

| Directory | Purpose | Language |
|-----------|---------|----------|
| `backend/` | REST API, business logic | Go |
| `frontend/` | User interface | TypeScript/React |
| `deploy/` | Docker, Kubernetes configs | YAML |
| `docs/` | Documentation | Markdown |
| `sample-repo/` | Example config repository | YAML |

### Key Files to Know

| File | Purpose |
|------|---------|
| `backend/cmd/configer/main.go` | Backend entry point |
| `frontend/src/App.tsx` | Frontend main component |
| `frontend/src/api.ts` | API client definitions |
| `deploy/docker-compose.yml` | Local dev stack |
| `Makefile` | Build automation |

---

## Next Steps

1. **Read the [README](README.md)** for project overview
2. **Check [IMPROVEMENTS.md](IMPROVEMENTS.md)** for tech stack suggestions
3. **Explore** `sample-repo/` to understand the config model
4. **Start coding** using `make dev`!

---

## More Information

- **Project README**: [README.md](README.md)
- **Improvements & Suggestions**: [IMPROVEMENTS.md](IMPROVEMENTS.md)
- **Future Plans**: [docs/PLAN.md](docs/PLAN.md)
- **GitHub**: [github.com/abhijeet-oxide/configer](https://github.com/abhijeet-oxide/configer)

---

**Happy coding! 🚀**
