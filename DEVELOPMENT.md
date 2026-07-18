# Local Development Guide

## Quick Start

### Prerequisites

- **Node.js** 18+ (for frontend and tooling)
- **Go** 1.25+ (for backend)
- **npm** or **pnpm** (frontend package manager)
- **Docker & Docker Compose** (optional, for containerized setup)

### One-Command Setup

```bash
npm install -g concurrently
npm setup
npm start
```

This will:
1. Create `.env` from `.env.example`
2. Install frontend and backend dependencies
3. Start both backend and frontend concurrently

### Manual Setup

**Backend:**
```bash
cd backend
go mod download
CONFIGER_REPO=../sample-repo go run ./cmd/configer
# Backend running on http://localhost:8080
```

**Frontend** (in another terminal):
```bash
cd frontend
npm install
npm run dev
# Frontend running on http://localhost:5173
```

## Development Workflow

### Making Changes to Backend

The backend runs via `go run`, so changes to Go files trigger automatic reloads (if using a file watcher like `nodemon` or VS Code's Go extension).

For manual rebuild:
```bash
cd backend
go run ./cmd/configer
```

### Making Changes to Frontend

The frontend dev server (Vite) automatically hot-reloads when TypeScript/React files change.

```bash
cd frontend
npm run dev
```

### Configuration Changes

Edit `.env` and restart the respective service:
- Backend: `ctrl+c` the backend, then restart
- Frontend: Usually auto-reloads; if not, restart with `npm run dev`

## API Documentation

### Live Swagger UI

When running locally:
```
http://localhost:8080/api/docs
```

The spec is generated from the handler annotations (the `// @Summary`,
`// @Router`, ... comments on each handler in `backend/internal/api`). It is
committed under `backend/internal/api/docs/` and embedded in the binary, so the
UI and raw spec work offline. Regenerate after changing any handler:

```bash
make docs        # or: cd backend && go generate ./internal/api
```

CI runs `make docs-check`, which fails the build if the committed spec is stale,
so the documentation can never silently drift from the code.

### Manual API Testing

```bash
# Health check
curl http://localhost:8080/api/health

# Get deployment metadata
curl http://localhost:8080/api/meta

# Get the OpenAPI spec (JSON or YAML)
curl http://localhost:8080/api/openapi.json | jq
curl http://localhost:8080/api/openapi.yaml
```

## Environment Variables

See [CONFIG.md](CONFIG.md) for full documentation.

Common overrides during development:

```bash
# Faster Git sync
CONFIGER_SYNC_SECONDS=5

# Verbose logging
CONFIGER_LOG_LEVEL=debug

# Disable Swagger (if you're modifying the spec)
FEATURE_SWAGGER_DOCS=false
```

## Testing

### Backend Tests

```bash
cd backend
go test ./...
```

### Frontend Tests

```bash
cd frontend
npm run test
```

### Run All Tests

```bash
npm test
```

## Building for Production

### Local Build

```bash
npm run build
```

Outputs:
- Backend binary: `backend/configer`
- Frontend dist: `frontend/dist/`

### Docker Build

```bash
npm run docker:up
```

Services:
- Frontend: http://localhost:8088
- Backend: http://localhost:8080
- Database: postgres://localhost:5432

Stop with:
```bash
npm run docker:down
```

## Troubleshooting

### Port already in use

Backend (8080):
```bash
lsof -i :8080
kill -9 <PID>
```

Frontend (5173):
```bash
lsof -i :5173
kill -9 <PID>
```

### Frontend can't reach backend

1. Ensure backend is running: `http://localhost:8080/health`
2. Check `VITE_API_URL` in `.env`: should be `http://localhost:8080`
3. Check browser console for CORS errors

### Go module issues

```bash
cd backend
go mod tidy
go mod download
go run ./cmd/configer
```

### Node version mismatch

Use a Node version manager (nvm, fnm, asdf):
```bash
nvm use 18
```

## Project Structure

```
configer/
├── backend/              # Go REST API
│   ├── cmd/configer/    # Main entry point (with config loading)
│   ├── internal/        # Core logic (to be organized)
│   └── go.mod
├── frontend/             # React + Vite SPA
│   ├── src/
│   │   ├── config.ts    # Runtime config loader
│   │   ├── main.tsx     # Entry point
│   │   └── ...
│   └── package.json
├── sample-repo/          # Fixture managed repository
├── deploy/               # Docker setup
│   └── docker-compose.yml
├── scripts/              # Utility scripts
│   └── setup.js         # First-time setup
├── package.json          # Root scripts (unified dev command)
├── .env.example          # Configuration template
├── CONFIG.md             # Configuration guide
└── DEVELOPMENT.md        # This file
```

## Next Steps

- Read [CONFIG.md](CONFIG.md) for advanced configuration
- Check [README.md](README.md) for feature overview

## Getting Help

- Check the [CONFIG.md](CONFIG.md) troubleshooting section
- Review backend logs: `CONFIGER_LOG_LEVEL=debug npm start`
- Open an issue on GitHub
