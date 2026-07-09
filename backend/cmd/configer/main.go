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
	repo := getenv("CONFIGER_REPO", "../sample-repo")
	addr := getenv("CONFIGER_ADDR", ":8080")

	srv := api.New(repo)
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("configer backend listening on %s (repo=%s)", addr, repo)
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
