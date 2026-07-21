# Configer Configuration Guide

## Overview

Configer supports flexible configuration through environment variables, making it easy to customize for different environments (local development, staging, production).

## Appearance / Theme

The whole look is driven by one file, `frontend/src/theme.config.ts`.

- **Colors, logo, app name:** edit `themeOverrides` (deep-merged over the
  defaults). Anything you omit falls back to what Configer ships.
- **Theme preset:** Configer ships more than one complete look. Pick one by
  setting a single value near the top of the presets section:

  ```ts
  export const ACTIVE_PRESET = "default";   // or "instrument"
  ```

  - `default` - the original soft-elevation look with the classic blue accent.
  - `instrument` - flat, bordered surfaces (no floating-card shadows), a
    deeper canvas, and a cobalt accent.

  Both presets always ship together, so you can also preview one live by
  setting the `data-preset` attribute on `<html>` in dev tools. Changing
  `ACTIVE_PRESET` takes effect on the next `npm run build` (or dev reload).

The monospace font (JetBrains Mono, used for configuration values) and the
matrix wordmark apply to every preset.

## Configuration Files

### `.env` (Local Development)

Copy `.env.example` to `.env` and customize values:

```bash
cp .env.example .env
```

Never commit `.env` to version control-use `.env.example` as the template.

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

### Platform (users, sessions, roles, audit)

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | *(unset)* | Postgres connection string for the platform database; unset = embedded SQLite under `CONFIGER_DATA` |
| `GITHUB_OAUTH_CLIENT_ID` | *(unset)* | GitHub OAuth app client id; unset = single-user mode (no login) |
| `GITHUB_OAUTH_CLIENT_SECRET` | *(unset)* | GitHub OAuth app client secret |
| `CONFIGER_OAUTH_CALLBACK` | *(unset)* | Public `/api/auth/callback` URL (needed behind a proxy) |
| `GITHUB_WEB_URL` | `https://github.com` | GitHub web base (GitHub Enterprise) |
| `CONFIGER_ADMINS` | *(unset)* | Comma-separated GitHub logins allowed to assign roles |
| `CONFIGER_DEFAULT_ROLE` | `editor` | Role where no explicit assignment exists: viewer / editor / approver |
| `CONFIGER_CORS_ORIGIN` | *(unset)* | One extra browser origin allowed to call the API |

### Git Integration

| Variable | Default | Description |
|----------|---------|-------------|
| `CONFIGER_GIT_NAME` | `Configer Bot` | Commit author name |
| `CONFIGER_GIT_EMAIL` | `configer-bot@localhost` | Commit author email |
| `GITHUB_TOKEN` | *(unset)* | GitHub personal access token for PR automation |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub API endpoint (for GitHub Enterprise) |

## Feature Flags

Generic boolean flags: any `CONFIGER_FLAG_<NAME>=true` becomes flag `<name>`,
readable in code via `cfg.Flags.Enabled("<name>")`. There are no built-in
flags today - Swagger docs and offline resilience are always on, and access
control is configured through the Platform variables above.

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
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
CONFIGER_ADMINS=platform-lead
```

## Runtime Configuration

### Changing Backend API URL at Runtime

The frontend can be reconfigured to point to a different backend without rebuilding:

1. **During development**: Edit `.env` and restart frontend dev server
2. **In production**: Set `VITE_API_URL` during the Docker build or serve from env-aware config

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

### Git sync not working

1. Check `CONFIGER_REPO` points to a valid git repository
2. Check `CONFIGER_SYNC_SECONDS` is > 0
3. View logs: `CONFIGER_LOG_LEVEL=debug npm start`

## Support

For configuration questions, see the main [README.md](README.md) or open an issue on GitHub.
