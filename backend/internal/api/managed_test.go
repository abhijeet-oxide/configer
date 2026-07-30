package api

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// A file in the explorer is mostly ordinary text with a handful of values the
// product actually manages. This is what lets the editor mark them: every
// managed value in one file with the line it sits on - in the content the
// explorer renders (draft applied), so a mark cannot drift a line away from the
// value it marks.
func TestManagedValuesInAFile(t *testing.T) {
	root := minimalRepo(t) // instances/staging/values.yaml: app.port 8080, bound as p1
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	var res struct {
		File   string `json:"file"`
		Values []struct {
			ParamID string `json:"paramId"`
			Name    string `json:"name"`
			Path    string `json:"path"`
			Line    int    `json:"line"`
			Col     int    `json:"col"`
			EndCol  int    `json:"endCol"`
		} `json:"values"`
	}
	doJSON(t, h, http.MethodGet, "/api/files/managed?file=instances/staging/values.yaml", nil, &res)
	if len(res.Values) != 1 {
		t.Fatalf("values = %+v, want the one managed value", res.Values)
	}
	v := res.Values[0]
	// app:\n  port: 8080 - the value is on line 2.
	// app:\n  port: 8080 - line 2, columns 9..13 ("8080"), which is what lets the
	// editor mark the value rather than the whole line.
	if v.ParamID != "p1" || v.Name != "app.port" || v.Path != "$.app.port" || v.Line != 2 {
		t.Fatalf("located %+v, want p1 app.port at line 2", v)
	}
	if v.Col != 9 || v.EndCol != 13 {
		t.Errorf("columns = %d..%d, want 9..13 (the value alone)", v.Col, v.EndCol)
	}

	// A file with nothing managed in it answers with an empty list, not an error.
	doJSON(t, h, http.MethodGet, "/api/files/managed?file=.configer/application.yaml", nil, &res)
	if len(res.Values) != 0 {
		t.Errorf("unmanaged file reported %+v", res.Values)
	}

	// A path outside the repository is refused.
	if rec := doRaw(t, h, http.MethodGet, "/api/files/managed?file=../../etc/passwd", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("escaping path status = %d, want 400", rec.Code)
	}
}

// XML files carry managed values too - a telco RAN repository is mostly XML -
// and etree keeps no line numbers, so the parsed Document falls back to a scan
// of the original bytes. Without that, every XML file in the explorer came back
// with nothing marked.
func TestManagedValuesInXML(t *testing.T) {
	root := xmlRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	var res struct {
		Values []struct {
			ParamID string `json:"paramId"`
			Line    int    `json:"line"`
			Col     int    `json:"col"`
			EndCol  int    `json:"endCol"`
		} `json:"values"`
	}
	doJSON(t, s.Routes(), http.MethodGet, "/api/files/managed?file=instances/edge/network.xml", nil, &res)
	if len(res.Values) != 1 || res.Values[0].ParamID != "x-ip" || res.Values[0].Line != 3 {
		t.Fatalf("located %+v, want x-ip on line 3", res.Values)
	}
	// "    <ip>10.0.0.1</ip>" - the value alone, between the tags.
	if v := res.Values[0]; v.Col != 9 || v.EndCol != 17 {
		t.Errorf("columns = %d..%d, want 9..17", v.Col, v.EndCol)
	}
}

// xmlRepo is a minimal application whose one parameter is bound into an XML
// file, on a line we can assert.
func xmlRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, content string) {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(".configer/application.yaml", "apiVersion: configer.io/v1\nkind: Application\nname: x\nlayout: plain-folders\n")
	write(".configer/parameters.yaml", `
apiVersion: configer.io/v1
kind: ParameterCatalog
parameters:
  - id: x-ip
    name: network.service.ip
    category: Networking
    type: ipv4
    scope: instance
    bindings:
      - { file: "{folder}/network.xml", path: /network/service/ip, format: xml }
`)
	write(".configer/instances.yaml", "apiVersion: configer.io/v1\nkind: InstanceRegistry\ninstances:\n  - { name: edge, folder: instances/edge }\n")
	write("instances/edge/network.xml", "<network>\n  <service>\n    <ip>10.0.0.1</ip>\n  </service>\n</network>\n")
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"}, {"add", "-A"},
		{"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	return root
}
