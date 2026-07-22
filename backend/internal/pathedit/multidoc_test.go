package pathedit

import (
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// A single YAML file frequently bundles several Kubernetes resources with "---"
// separators. Reads and surgical edits must address the Nth document via a
// "[N]$…" selector, and an edit must leave every other document (and all
// comments) byte-for-byte intact.
const multiDoc = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  LOG_LEVEL: info # tune me
---
apiVersion: v1
kind: Service
metadata:
  name: app
spec:
  ports:
    - port: 8080 # http
  type: ClusterIP
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  replicas: 2
`

func TestMultiDocGet(t *testing.T) {
	cases := []struct {
		path string
		want any
	}{
		{"[0]$.data.LOG_LEVEL", "info"},
		{"[1]$.spec.ports[0].port", 8080},
		{"[1]$.spec.type", "ClusterIP"},
		{"[2]$.spec.replicas", 2},
	}
	for _, c := range cases {
		got, ok, err := Get([]byte(multiDoc), "yaml", c.path)
		if err != nil || !ok {
			t.Fatalf("Get(%s): ok=%v err=%v", c.path, ok, err)
		}
		if toString(got) != toString(c.want) {
			t.Errorf("Get(%s) = %v, want %v", c.path, got, c.want)
		}
	}
	// A cached Document resolves across documents too.
	d, err := Parse([]byte(multiDoc), "yaml")
	if err != nil {
		t.Fatal(err)
	}
	if v, ok, _ := d.Get("[2]$.spec.replicas"); !ok || toString(v) != "2" {
		t.Errorf("Document.Get replicas = %v ok=%v", v, ok)
	}
}

func TestMultiDocSetPreservesOtherDocs(t *testing.T) {
	out, err := Set([]byte(multiDoc), "yaml", "[2]$.spec.replicas", model.TypeInteger, 5)
	if err != nil {
		t.Fatal(err)
	}
	// The edited document changed.
	if !strings.Contains(out, "replicas: 5") {
		t.Errorf("replicas not updated:\n%s", out)
	}
	// Every untouched document and its inline comments survive.
	for _, keep := range []string{"LOG_LEVEL: info # tune me", "port: 8080 # http", "type: ClusterIP"} {
		if !strings.Contains(out, keep) {
			t.Errorf("edit disturbed another document; missing %q in:\n%s", keep, out)
		}
	}
	// The stream still has exactly two separators (three documents).
	if n := strings.Count(out, "\n---\n"); n != 2 {
		t.Errorf("document count changed: got %d separators, want 2:\n%s", n, out)
	}
	// The addressed value reads back through the same selector.
	if v, ok, _ := Get([]byte(out), "yaml", "[2]$.spec.replicas"); !ok || toString(v) != "5" {
		t.Errorf("round-trip replicas = %v ok=%v", v, ok)
	}
}

// A single-document file must round-trip unchanged: the document selector code
// path is never taken, so existing byte-exact behavior is preserved.
func TestSingleDocUnaffected(t *testing.T) {
	src := "service:\n  port: 8080 # keep\n"
	out, err := Set([]byte(src), "yaml", "$.service.port", model.TypeInteger, 9090)
	if err != nil {
		t.Fatal(err)
	}
	if out != "service:\n  port: 9090 # keep\n" {
		t.Errorf("single-doc edit drifted:\n%q", out)
	}
}

func toString(v any) string {
	return strings.TrimSpace(strings.ReplaceAll(
		strings.ReplaceAll(sprint(v), "\n", ""), " ", ""))
}

func sprint(v any) string {
	switch t := v.(type) {
	case string:
		return t
	default:
		return itoaAny(v)
	}
}

func itoaAny(v any) string {
	switch t := v.(type) {
	case int:
		return itoa(t)
	case int64:
		return itoa(int(t))
	case float64:
		return itoa(int(t))
	default:
		return ""
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}
