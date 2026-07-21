// Command configer runs the Configer backend API server.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/api"
	"github.com/abhijeet-oxide/configer/backend/internal/config"
)

func main() {
	// -healthcheck lets the container HEALTHCHECK probe liveness without a shell
	// or curl in the image: the same binary hits its own /api/health and maps
	// the result to an exit code. Handled before anything else opens state.
	healthcheck := flag.Bool("healthcheck", false, "probe the local /api/health endpoint and exit 0 (healthy) or 1")
	flag.Parse()
	if *healthcheck {
		os.Exit(runHealthcheck(config.Load().Addr))
	}

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
		Addr:    cfg.Addr,
		Handler: hub.Routes(),
		// Bound every phase of a connection so slow or stalled clients cannot
		// pin a goroutine open indefinitely (slowloris on the header, the body,
		// or the response). WriteTimeout is generous because a submit pushes to
		// GitHub inside the request; IdleTimeout reaps kept-alive connections.
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	logger.Info("configer backend starting",
		slog.Int("repositories", hub.Count()),
		slog.String("dataDir", cfg.DataDir),
		slog.Any("config", cfg),
	)

	// Serve until a termination signal, then drain in-flight requests instead of
	// dropping them (clean rollouts, no truncated responses).
	go func() {
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server error", slog.Any("error", err))
			os.Exit(1)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	logger.Info("shutting down, draining in-flight requests")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", slog.Any("error", err))
	}
	if err := hub.Close(); err != nil {
		logger.Error("platform store close failed", slog.Any("error", err))
	}
}

// runHealthcheck GETs the local /api/health endpoint and returns a process exit
// code: 0 when the server answers 200, 1 otherwise. addr is the listen address
// (e.g. ":8080"); a bare-port form is resolved against localhost.
func runHealthcheck(addr string) int {
	host := addr
	if strings.HasPrefix(host, ":") {
		host = "127.0.0.1" + host
	}
	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://%s/api/health", host))
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		return 1
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "healthcheck: status", resp.StatusCode)
		return 1
	}
	return 0
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
