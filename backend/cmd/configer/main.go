// Command configer runs the Configer backend API server.
package main

import (
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/api"
	"github.com/abhijeet-oxide/configer/backend/internal/config"
)

func main() {
	cfg := config.Load()
	logger := newLogger(cfg)
	slog.SetDefault(logger)

	hub, err := api.NewHub(cfg.DataDir, cfg.Repo, cfg.SyncInterval)
	if err != nil {
		logger.Error("init failed", slog.Any("error", err))
		os.Exit(1)
	}
	hub.Logger = logger

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           hub.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	logger.Info("configer backend starting",
		slog.Int("repositories", hub.Count()),
		slog.String("dataDir", cfg.DataDir),
		slog.Any("config", cfg),
	)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("server error", slog.Any("error", err))
		os.Exit(1)
	}
}

// newLogger builds the structured logger. Text is friendlier in a dev terminal;
// JSON is what log aggregators (Loki, ELK, Datadog, CloudWatch) expect, so
// production deployments set CONFIGER_LOG_FORMAT=json.
func newLogger(cfg config.Config) *slog.Logger {
	opts := &slog.HandlerOptions{Level: cfg.LogLevel}
	var h slog.Handler
	if cfg.LogFormat == "json" {
		h = slog.NewJSONHandler(os.Stdout, opts)
	} else {
		h = slog.NewTextHandler(os.Stdout, opts)
	}
	return slog.New(h)
}
