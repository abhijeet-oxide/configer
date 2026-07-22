package pathedit

import (
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

const blankDoc = `# header
replicaCount: 1

image:
  tag: "2.9.0-rc3"

service:
  type: ClusterIP
  port: 8080

logging:
  level: debug
`

// Adding a brand-new nested key (whose parent map does not exist) is a
// structural edit that goes through a full re-encode. The blank lines that
// separate the untouched blocks must survive byte-for-byte; only the new block
// is added. Regression test for yaml.v3 stripping bare blank lines.
func TestSetNewNestedKeyPreservesBlankLines(t *testing.T) {
	out, err := Set([]byte(blankDoc), "yaml", "$.ingress.host", model.TypeString, "app.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out, blankDoc) {
		t.Errorf("original blocks not preserved byte-for-byte.\n--- got ---\n%s", out)
	}
	if !strings.Contains(out, "ingress:\n  host: app.example.com") {
		t.Errorf("new key not written:\n%s", out)
	}
}

// Removing a key is also structural; the surrounding blank lines must stay.
func TestRemoveKeyPreservesBlankLines(t *testing.T) {
	out, err := Remove([]byte(blankDoc), "yaml", "$.logging.level", model.TypeString)
	if err != nil {
		t.Fatal(err)
	}
	want := `# header
replicaCount: 1

image:
  tag: "2.9.0-rc3"

service:
  type: ClusterIP
  port: 8080
`
	if out != want {
		t.Errorf("removal did not preserve blanks.\n--- got ---\n%q\n--- want ---\n%q", out, want)
	}
}
