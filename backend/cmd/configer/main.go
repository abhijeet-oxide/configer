package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"
)

// Config holds runtime configuration from environment variables
type Config struct {
	Repo         string
	Addr         string
	Env          string
	Version      string
	LogLevel     string
	SyncSeconds  int
	GitUserName  string
	GitUserEmail string
	Features     map[string]bool
}

// LoadConfig reads environment variables with sensible defaults
func LoadConfig() Config {
	return Config{
		Repo:         getEnv("CONFIGER_REPO", "../sample-repo"),
		Addr:         getEnv("CONFIGER_ADDR", ":8080"),
		Env:          getEnv("CONFIGER_ENV", "development"),
		Version:      getEnv("CONFIGER_VERSION", "0.1.0"),
		LogLevel:     getEnv("CONFIGER_LOG_LEVEL", "info"),
		SyncSeconds:  getEnvInt("CONFIGER_SYNC_SECONDS", 30),
		GitUserName:  getEnv("GIT_USER_NAME", "Configer Bot"),
		GitUserEmail: getEnv("GIT_USER_EMAIL", "bot@configer.local"),
		Features: map[string]bool{
			"offline_mode": getEnvBool("FEATURE_OFFLINE_MODE", true),
			"ai_module":    getEnvBool("FEATURE_AI_MODULE", false),
			"rbac":         getEnvBool("FEATURE_RBAC", false),
			"sso":          getEnvBool("FEATURE_SSO", false),
		},
	}
}

func getEnv(key, defaultVal string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return defaultVal
}

func getEnvInt(key string, defaultVal int) int {
	valStr := getEnv(key, "")
	if valStr == "" {
		return defaultVal
	}
	val, err := strconv.Atoi(valStr)
	if err != nil {
		log.Printf("Warning: %s is not a valid integer, using default %d\n", key, defaultVal)
		return defaultVal
	}
	return val
}

func getEnvBool(key string, defaultVal bool) bool {
	valStr := getEnv(key, "")
	if valStr == "" {
		return defaultVal
	}
	val, err := strconv.ParseBool(valStr)
	if err != nil {
		log.Printf("Warning: %s is not a valid boolean, using default %v\n", key, defaultVal)
		return defaultVal
	}
	return val
}

func main() {
	cfg := LoadConfig()

	log.Printf("Starting Configer %s (env: %s)\n", cfg.Version, cfg.Env)
	log.Printf("Repository: %s\n", cfg.Repo)
	log.Printf("Listening on %s\n", cfg.Addr)
	log.Printf("Sync interval: %d seconds\n", cfg.SyncSeconds)
	log.Printf("Features: %v\n", cfg.Features)

	// Setup HTTP handlers
	mux := http.NewServeMux()

	// Health check
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","version":"%s"}`, cfg.Version)
	})

	// Meta endpoint - reports config and enabled features
	mux.HandleFunc("/api/meta", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		featureJSON := ""
		for k, v := range cfg.Features {
			if featureJSON != "" {
				featureJSON += ","
			}
			featureJSON += fmt.Sprintf(`"%s":%v`, k, v)
		}
		fmt.Fprintf(w, `{"name":"Configer (%s)","version":"%s","environment":"%s","features":{%s}}`, cfg.Env, cfg.Version, cfg.Env, featureJSON)
	})

	// Placeholder for grid endpoint
	mux.HandleFunc("/api/grid", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"message":"Grid endpoint - implementation pending"}`)
	})

	server := &http.Server{
		Addr:         cfg.Addr,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}
