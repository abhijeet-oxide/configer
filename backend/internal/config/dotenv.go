package config

import (
	"bufio"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// A `.env` file is how a developer configures a local Configer: `.env.example`
// says "copy to .env and adjust", and every deployment guide names the same
// variables. Nothing read that file, so filling in real GitHub OAuth
// credentials changed nothing and the app kept reporting sign-in as
// unconfigured - the configuration was not wrong, it was never read.
//
// Two rules make this safe:
//
//  1. The real environment ALWAYS wins. The file fills in variables that are
//     not already set, never overrides them. A container's environment,
//     a systemd unit, a `FOO=bar go run ...` - all keep their meaning, and a
//     stale `.env` left in a checkout can never quietly shadow production
//     configuration.
//  2. The search walks UP from the working directory. The backend runs from
//     `backend/` (`make dev`, `go run ./cmd/configer`) while the documented
//     `.env` sits at the repository root, so looking only in the working
//     directory would miss the very file the docs tell people to write.
//
// CONFIGER_ENV_FILE names an explicit file and skips the search entirely.

// how far up the tree to look for a .env: enough to climb out of backend/ (and
// one nested command directory) without wandering into the user's home.
const dotenvSearchDepth = 4

// loadDotEnv finds the first .env at or above the working directory and applies
// it to the process environment without overriding anything already set. It
// returns the file it used ("" when there was none), for logging.
func loadDotEnv() string {
	if explicit := strings.TrimSpace(os.Getenv("CONFIGER_ENV_FILE")); explicit != "" {
		if applyDotEnv(explicit) == nil {
			return explicit
		}
		// A file the operator named explicitly and we could not read is worth
		// saying out loud: they believe it is configuring the deployment.
		slog.Warn("CONFIGER_ENV_FILE could not be read", slog.String("path", explicit))
		return ""
	}
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for i := 0; i < dotenvSearchDepth; i++ {
		candidate := filepath.Join(dir, ".env")
		if st, serr := os.Stat(candidate); serr == nil && !st.IsDir() {
			if applyDotEnv(candidate) == nil {
				return candidate
			}
			return ""
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break // reached the filesystem root
		}
		dir = parent
	}
	return ""
}

// applyDotEnv parses one file and sets the variables it declares that are not
// already present in the environment.
func applyDotEnv(path string) error {
	f, err := os.Open(path) // #nosec G304 - operator-supplied config path, by design
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		key, value, ok := parseDotEnvLine(sc.Text())
		if !ok {
			continue
		}
		// Rule 1: never override what the environment already says.
		if _, present := os.LookupEnv(key); present {
			continue
		}
		_ = os.Setenv(key, value)
	}
	return sc.Err()
}

// parseDotEnvLine reads one `KEY=value` line. It understands the shapes a
// hand-written .env actually contains: comments, blank lines, a leading
// `export`, quoted values (which keep their inline `#` and whitespace), and
// unquoted values (which lose a trailing comment and surrounding spaces).
func parseDotEnvLine(line string) (key, value string, ok bool) {
	s := strings.TrimSpace(line)
	if s == "" || strings.HasPrefix(s, "#") {
		return "", "", false
	}
	s = strings.TrimPrefix(s, "export ")
	key, rest, found := strings.Cut(s, "=")
	if !found {
		return "", "", false
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return "", "", false
	}
	rest = strings.TrimSpace(rest)
	// A quoted value is taken literally, so a secret containing '#' survives.
	if len(rest) >= 2 {
		if (rest[0] == '"' && rest[len(rest)-1] == '"') || (rest[0] == '\'' && rest[len(rest)-1] == '\'') {
			return key, rest[1 : len(rest)-1], true
		}
	}
	// Unquoted: an inline comment ends the value.
	if i := strings.Index(rest, " #"); i >= 0 {
		rest = rest[:i]
	}
	return key, strings.TrimSpace(rest), true
}
