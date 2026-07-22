package pathedit

import (
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// Editing one scalar must change exactly one line: blank lines, comments, key
// order and every unmanaged byte survive. A full node-tree re-encode drifts
// blank lines (yaml.v3 drops bare ones and adds others), so the engine splices
// the value in place instead.
func TestInPlaceScalarPreservesLayout(t *testing.T) {
	src := "global:\n" +
		"  namespace: prod\n" +
		"\n" +
		"# services section\n" +
		"services:\n" +
		"  datastore:\n" +
		"    replicas: 3\n" +
		"    port: 5432 # postgres wire protocol\n" +
		"\n" +
		"  cache:\n" +
		"    port: 6379\n"

	out, err := Set([]byte(src), "yaml", "$.services.datastore.port", model.TypeInteger, 5533)
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Replace(src, "port: 5432 # postgres wire protocol", "port: 5533 # postgres wire protocol", 1)
	if out != want {
		t.Errorf("edit was not a minimal one-line diff.\n got:\n%q\nwant:\n%q", out, want)
	}
	// The blank lines and the comment line are still there.
	if strings.Count(out, "\n\n") != strings.Count(src, "\n\n") {
		t.Errorf("blank-line count changed: got %d, want %d", strings.Count(out, "\n\n"), strings.Count(src, "\n\n"))
	}
	if !strings.Contains(out, "# services section") {
		t.Error("standalone comment lost")
	}
}

// A quoted string stays quoted, so a value that would parse as a number if bare
// (e.g. an image tag "2.10") is never silently retyped.
func TestInPlaceScalarKeepsQuoting(t *testing.T) {
	src := "image:\n  tag: \"2.8.0\"\n  name: web\n"
	out, err := Set([]byte(src), "yaml", "$.image.tag", model.TypeString, "2.10")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `tag: "2.10"`) {
		t.Errorf("quoting not preserved:\n%s", out)
	}
	if !strings.Contains(out, "name: web") {
		t.Errorf("sibling drifted:\n%s", out)
	}
}

// Structural edits (creating a brand-new key) still work: they take the
// re-encode path, and the value lands.
func TestInPlaceFallbackForNewKey(t *testing.T) {
	src := "a:\n  b: 1\n"
	out, err := Set([]byte(src), "yaml", "$.a.c", model.TypeInteger, 2)
	if err != nil {
		t.Fatal(err)
	}
	if v, _, _ := Get([]byte(out), "yaml", "$.a.c"); v != 2 {
		t.Errorf("new key not set: %v\n%s", v, out)
	}
	if v, _, _ := Get([]byte(out), "yaml", "$.a.b"); v != 1 {
		t.Errorf("existing key lost: %v", v)
	}
}
