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

**Where it is read from.** The backend looks for `.env` in its working
directory and then upwards (so the repository-root file is found even though
the server runs from `backend/`), and the Vite config reads the same root file
plus an optional `frontend/.env`. Point `CONFIGER_ENV_FILE` at an explicit path
to skip the search.

**Precedence.** The real environment always wins: `.env` only fills in
variables that are not already set. A container's environment, a systemd unit,
or a one-off `GITHUB_TOKEN=... go run ./cmd/configer` keeps its meaning, and a
stale `.env` in a checkout can never shadow a real deployment's configuration.

**Verifying it was read.** The startup log names the file it used and says why
sign-in is off when it is:

```
configer backend starting ... config.envFile=/path/to/.env
auth disabled: single-user mode reason="GITHUB_OAUTH_CLIENT_SECRET is not set ..."
```

An empty `config.envFile=` means no file was found - the values in it are not
being applied.

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
| `CONFIGER_ENV_FILE` | *(unset)* | Explicit `.env` path; skips the upward search |
| `CONFIGER_LOCAL_FOLDERS` | *(auto)* | Offer the "Local folder" source. Auto-detected: on for a non-production server reached from the same machine, off for anything hosted. Set `true`/`false` to decide explicitly |

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
| `VITE_API_BASE_URL` | *(same origin `/api`)* | Base URL the built SPA calls. Only needed when the API is on a different origin than the UI |
| `VITE_API_PROXY_TARGET` | `http://localhost:8080` | Where the dev server proxies `/api` |

The product name, logo and palette are **not** environment variables: they live
in `frontend/src/theme.config.ts`, which drives the CSS custom properties, the
Ant Design tokens and the favicon from one place.

**`VITE_API_BASE_URL` must end at the `/api` prefix.** Every endpoint is
mounted there, so a value naming only the host would send each call to
`/health` instead of `/api/health` - an API that answers 404 to everything
while looking correctly configured. A bare origin is accepted and gets the
prefix appended:

| Configured | Actually called |
|------------|-----------------|
| *(empty)* | `/api` on the page's own origin |
| `https://api.example.com` | `https://api.example.com/api` |
| `https://api.example.com/api` | `https://api.example.com/api` |
| `https://example.com/configer/api` | used exactly as written |

A cross-origin API also needs `CONFIGER_CORS_ORIGIN` set to the UI's origin on
the backend, or the browser will block the calls.

### Runtime Discovery

The frontend queries the backend at runtime to discover:
- `/api/health` - deployment name, version and environment (works with no
  application connected; this is also the boot availability check)
- `/api/capabilities` - which New Application sources this deployment supports,
  so the UI never offers a workflow that cannot succeed here
- `/api/meta` - the active application's project and branch

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

### Every API request returns 404

The UI is reaching *a* server, just not the API. Almost always the configured
base URL is missing its `/api` prefix.

1. Check `VITE_API_BASE_URL` (or `window.__CONFIGER__.apiBaseUrl`) ends at
   `/api` - see the table under **Frontend Configuration**
2. Confirm the backend answers directly: `curl <base-url>/health`
3. The boot screen names the address it tried when the failure is an address
   problem; that string is exactly what the browser requested

### Backend can't be reached at all

1. Ensure the backend is running on the configured address
2. For a cross-origin setup, set `CONFIGER_CORS_ORIGIN` to the UI's origin
3. Check the browser console for CORS errors

### `.env` changes have no effect

1. Check the startup log line `config.envFile=` - empty means no file was found
2. Remember the real environment wins over the file: a variable already
   exported (or set in a compose file) is not overridden by `.env`
3. Point `CONFIGER_ENV_FILE` at the file explicitly to remove all doubt

### GitHub sign-in stays unavailable

1. **Both** `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` are
   required; with only the id, sign-in would fail at the token exchange, so it
   is not offered
2. The startup log says which one is missing (`auth disabled: ... reason=...`)
3. The OAuth app's callback URL must be `<public-url>/api/auth/callback`; set
   `CONFIGER_OAUTH_CALLBACK` when a proxy fronts the deployment

### Git sync not working

1. Check `CONFIGER_REPO` points to a valid git repository
2. Check `CONFIGER_SYNC_SECONDS` is > 0
3. View logs: `CONFIGER_LOG_LEVEL=debug npm start`

## Support

For configuration questions, see the main [README.md](README.md) or open an issue on GitHub.
