// Command configer runs the Configer backend API server.
package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/api"
)

func main() {
	// CONFIGER_DATA holds server-side operational state: the workspace
	// registry and the clones of remotely connected repositories.
	dataDir := getenv("CONFIGER_DATA", "./configer-data")
	// CONFIGER_REPO seeds the workspace with one local repository when the
	// registry is empty (the original single-repo mode keeps working).
	seed := getenv("CONFIGER_REPO", "../sample-repo")
	addr := getenv("CONFIGER_ADDR", ":8080")

	hub, err := api.NewHub(dataDir, seed, api.SyncIntervalFromEnv())
	if err != nil {
		log.Fatalf("init: %v", err)
	}
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           hub.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("configer backend listening on %s (%d repositories, data=%s)", addr, hub.Count(), dataDir)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
