// Package config centralizes every environment variable Configer reads, with
// defaults, typing, and light validation, so configuration is documented in one
// place instead of scattered os.Getenv calls. It also loads simple feature
// flags (CONFIGER_FLAG_*). See .env.example for the full list.
package config

import (
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the fully-resolved runtime configuration.
type Config struct {
	// Server
	Addr    string // CONFIGER_ADDR (default ":8080")
	DataDir string // CONFIGER_DATA (server-side state + clones)
	Repo    string // CONFIGER_REPO (bootstrap repository)

	// Identity (surfaced in the UI and in commit attribution)
	Version     string // CONFIGER_VERSION
	Environment string // CONFIGER_ENV (development|staging|production)
	GitName     string // CONFIGER_GIT_NAME
	GitEmail    string // CONFIGER_GIT_EMAIL

	// Behavior
	SyncInterval time.Duration // CONFIGER_SYNC_SECONDS
	GitHubToken  string        // GITHUB_TOKEN (secret; used for PRs/merges)

	// Observability
	LogLevel  slog.Level // CONFIGER_LOG_LEVEL (debug|info|warn|error)
	LogFormat string     // CONFIGER_LOG_FORMAT (text|json)

	// Flags holds boolean feature flags parsed from CONFIGER_FLAG_<NAME>=true.
	Flags Flags
}

// Flags is a small env-driven feature-flag set. For anything richer (targeting,
// gradual rollout, a management UI) adopt OpenFeature.
type Flags map[string]bool

// Enabled reports whether a named flag is on. Names are lower-cased.
func (f Flags) Enabled(name string) bool { return f[strings.ToLower(name)] }

// Load reads configuration from the environment, applying defaults.
func Load() Config {
	c := Config{
		Addr:         env("CONFIGER_ADDR", ":8080"),
		DataDir:      env("CONFIGER_DATA", "./configer-data"),
		Repo:         env("CONFIGER_REPO", "../sample-repo"),
		Version:      env("CONFIGER_VERSION", "dev"),
		Environment:  env("CONFIGER_ENV", "development"),
		GitName:      env("CONFIGER_GIT_NAME", "Configer Bot"),
		GitEmail:     env("CONFIGER_GIT_EMAIL", "configer-bot@localhost"),
		SyncInterval: time.Duration(envInt("CONFIGER_SYNC_SECONDS", 30)) * time.Second,
		GitHubToken:  os.Getenv("GITHUB_TOKEN"),
		LogLevel:     parseLevel(env("CONFIGER_LOG_LEVEL", "info")),
		LogFormat:    env("CONFIGER_LOG_FORMAT", "text"),
		Flags:        loadFlags(),
	}
	if c.SyncInterval < time.Second {
		c.SyncInterval = time.Second // never hot-loop the sync
	}
	return c
}

// LogValue redacts the token so a config dump is safe to log.
func (c Config) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("addr", c.Addr),
		slog.String("env", c.Environment),
		slog.String("version", c.Version),
		slog.Duration("syncInterval", c.SyncInterval),
		slog.Bool("githubToken", c.GitHubToken != ""),
		slog.String("logLevel", c.LogLevel.String()),
		slog.String("logFormat", c.LogFormat),
		slog.Any("flags", c.enabledFlags()),
	)
}

func (c Config) enabledFlags() []string {
	var on []string
	for k, v := range c.Flags {
		if v {
			on = append(on, k)
		}
	}
	return on
}

func loadFlags() Flags {
	f := Flags{}
	const prefix = "CONFIGER_FLAG_"
	for _, kv := range os.Environ() {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || !strings.HasPrefix(k, prefix) {
			continue
		}
		name := strings.ToLower(strings.TrimPrefix(k, prefix))
		f[name] = truthy(v)
	}
	return f
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
