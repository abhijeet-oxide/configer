# Configer Configuration Guide

## Overview

Configer supports flexible configuration through environment variables, making it easy to customize for different environments (local development, staging, production).

## Configuration Files

### `.env` (Local Development)

Copy `.env.example` to `.env` and customize values:

```bash
cp .env.example .env
```

Never commit `.env` to version control—use `.env.example` as the template.

## Backend Configuration

### Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `CONFIGER_REPO` | `./sample-repo` | Path to the managed Git repository (absolute or relative) |
| `CONFIGER_ADDR` | `:8080` | Listen address and port for the REST API |
| `CONFIGER_ENV` | `development` | Deployment environment: `development`, `staging`, `production` |
| `CONFIGER_VERSION` | `0.1.0` | API version (reported in `/api/meta`) |
| `CONFIGER_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `CONFIGER_SYNC_SECONDS` | `30` | Git sync interval (seconds); 0 = disabled |

### Database (Phase 1+)

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | *(unset)* | Postgres connection string; if set, enables grid cache and metadata storage |

### Git Integration

| Variable | Default | Description |
|----------|---------|-------------|
| `GIT_USER_NAME` | `Configer Bot` | Commit author name |
| `GIT_USER_EMAIL` | `bot@configer.local` | Commit author email |
| `GITHUB_TOKEN` | *(unset)* | GitHub personal access token for PR automation |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub API endpoint (for GitHub Enterprise) |

## Feature Flags

Enable/disable upcoming features:

| Flag | Default | Description |
|------|---------|-------------|
| `FEATURE_SWAGGER_DOCS` | `true` | Enable auto-generated Swagger UI at `/api/docs` |
| `FEATURE_OFFLINE_MODE` | `true` | Enable offline resilience (localStorage snapshots) |
| `FEATURE_AI_MODULE` | `false` | Enable AI-powered intent → change request feature |
| `FEATURE_RBAC` | `false` | Enable role-based access control |
| `FEATURE_SSO` | `false` | Enable OIDC/SAML single sign-on |

## Frontend Configuration

### Build-time Variables

Frontend config is baked at build time using Vite's `VITE_*` prefix:

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:8080` | Backend API base URL |
| `VITE_APP_NAME` | `Configer` | App name shown in UI |
| `VITE_APP_VERSION` | `0.1.0` | App version |

### Runtime Discovery

The frontend also queries `/api/meta` at runtime to discover:
- Deployment name
- Actual backend version
- Environment (dev/staging/prod)
- Enabled feature flags

## Environment-Specific Examples

### Local Development

```bash
CONFIGER_REPO=./sample-repo
CONFIGER_ADDR=:8080
CONFIGER_ENV=development
CONFIGER_LOG_LEVEL=debug
VITE_API_URL=http://localhost:8080
FEATURE_SWAGGER_DOCS=true
FEATURE_AI_MODULE=false
```

### Docker Compose (Self-Hosted)

```yaml
services:
  backend:
    environment:
      CONFIGER_REPO: /repo
      CONFIGER_ADDR: :8080
      CONFIGER_ENV: production
      DATABASE_URL: postgres://configer:configer@postgres:5432/configer
```

### Production (High-Security)

```bash
CONFIGER_ENV=production
CONFIGER_LOG_LEVEL=warn
DATABASE_URL=postgres://user:pass@db.example.com/configer
GITHUB_TOKEN=ghp_xxxx...  # Keep in secrets manager
FEATURE_RBAC=true
FEATURE_SSO=true
```

## Runtime Configuration

### Changing Backend API URL at Runtime

The frontend can be reconfigured to point to a different backend without rebuilding:

1. **During development**: Edit `.env` and restart frontend dev server
2. **In production**: Set `VITE_API_URL` during the Docker build or serve from env-aware config

### Feature Flags at Runtime

Backend feature flags are reported via `GET /api/meta`:

```json
{
  "name": "Configer (Dev)",
  "version": "0.1.0",
  "environment": "development",
  "features": {
    "swagger_docs": true,
    "offline_mode": true,
    "ai_module": false,
    "rbac": false,
    "sso": false
  }
}
```

The frontend reads this to conditionally show UI elements.

## Quick Start

### Local Development (Single Command)

```bash
# Install dependencies
cd frontend && npm install && cd ..
cd backend && go mod download && cd ..

# Start everything
npm start

# Opens:
# - Frontend: http://localhost:5173
# - Backend API: http://localhost:8080
# - Swagger Docs: http://localhost:8080/api/docs
```

### Docker Compose

```bash
# Build and start all services
npm run docker:up

# Frontend: http://localhost:8088
# Backend: http://localhost:8080
# Database: postgres://localhost:5432
```

## Troubleshooting

### Backend API URL not found

1. Check `VITE_API_URL` is set correctly
2. Ensure backend is running on the configured address
3. Check CORS headers in browser console

### Feature flags not taking effect

1. Backend flags are read at startup—restart after changing `.env`
2. Frontend flags are fetched from `/api/meta`—refresh the browser
3. Built-in flags (like AI module) may have code conditionals that also need enabling

### Git sync not working

1. Check `CONFIGER_REPO` points to a valid git repository
2. Check `CONFIGER_SYNC_SECONDS` is > 0
3. View logs: `CONFIGER_LOG_LEVEL=debug npm start`

## Support

For configuration questions, see the main [README.md](README.md) or open an issue on GitHub.
