package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseDotEnvLine(t *testing.T) {
	cases := []struct {
		line      string
		key, want string
		ok        bool
	}{
		{"GITHUB_OAUTH_CLIENT_ID=Iv1.abc123", "GITHUB_OAUTH_CLIENT_ID", "Iv1.abc123", true},
		{"  CONFIGER_ENV = production ", "CONFIGER_ENV", "production", true},
		{"export GITHUB_TOKEN=ghp_x", "GITHUB_TOKEN", "ghp_x", true},
		{`QUOTED="a value # with hash"`, "QUOTED", "a value # with hash", true},
		{"SINGLE='keep me'", "SINGLE", "keep me", true},
		{"TRAILING=value # a comment", "TRAILING", "value", true},
		{"EMPTY=", "EMPTY", "", true},
		{"# a comment", "", "", false},
		{"", "", "", false},
		{"no-equals-here", "", "", false},
		{"=novalue", "", "", false},
	}
	for _, c := range cases {
		k, v, ok := parseDotEnvLine(c.line)
		if ok != c.ok || k != c.key || v != c.want {
			t.Errorf("parseDotEnvLine(%q) = (%q, %q, %v), want (%q, %q, %v)",
				c.line, k, v, ok, c.key, c.want, c.ok)
		}
	}
}

// The real environment must win: a stale .env in a checkout can never shadow
// what a container, a systemd unit or a `FOO=bar go run` already set.
func TestApplyDotEnvDoesNotOverrideEnvironment(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	write(t, path, "CONFIGER_TEST_PRESET=from-file\nCONFIGER_TEST_NEW=from-file\n")

	t.Setenv("CONFIGER_TEST_PRESET", "from-environment")
	os.Unsetenv("CONFIGER_TEST_NEW")
	t.Cleanup(func() { os.Unsetenv("CONFIGER_TEST_NEW") })

	if err := applyDotEnv(path); err != nil {
		t.Fatalf("applyDotEnv: %v", err)
	}
	if got := os.Getenv("CONFIGER_TEST_PRESET"); got != "from-environment" {
		t.Errorf("preset variable = %q, want it untouched by the file", got)
	}
	if got := os.Getenv("CONFIGER_TEST_NEW"); got != "from-file" {
		t.Errorf("unset variable = %q, want it filled in from the file", got)
	}
}

// The documented .env sits at the repository root while the backend runs from
// backend/, so the search has to climb - this is the exact case that made a
// filled-in .env look ignored.
func TestLoadDotEnvFindsFileInParentDirectory(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, ".env"), "CONFIGER_TEST_PARENT=found\n")
	nested := filepath.Join(root, "backend", "cmd")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	chdir(t, nested)
	os.Unsetenv("CONFIGER_TEST_PARENT")
	t.Cleanup(func() { os.Unsetenv("CONFIGER_TEST_PARENT") })

	used := loadDotEnv()
	if used == "" {
		t.Fatal("loadDotEnv found no file; want the one two directories up")
	}
	if got := os.Getenv("CONFIGER_TEST_PARENT"); got != "found" {
		t.Errorf("CONFIGER_TEST_PARENT = %q, want %q", got, "found")
	}
}

func TestLoadDotEnvHonorsExplicitFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "custom.env")
	write(t, path, "CONFIGER_TEST_EXPLICIT=yes\n")
	t.Setenv("CONFIGER_ENV_FILE", path)
	os.Unsetenv("CONFIGER_TEST_EXPLICIT")
	t.Cleanup(func() { os.Unsetenv("CONFIGER_TEST_EXPLICIT") })

	if used := loadDotEnv(); used != path {
		t.Fatalf("loadDotEnv() = %q, want %q", used, path)
	}
	if got := os.Getenv("CONFIGER_TEST_EXPLICIT"); got != "yes" {
		t.Errorf("CONFIGER_TEST_EXPLICIT = %q, want %q", got, "yes")
	}
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func chdir(t *testing.T, dir string) {
	t.Helper()
	prev, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(prev) })
}
