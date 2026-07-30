package api

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// A draft item whose path no longer fits the file it maps into must not take the
// Files explorer down with it. The explorer PREVIEWS files with the draft applied;
// when one item cannot be written, the file is shown as it stands and the rest of
// the listing is unaffected. Returning the write error instead answered the whole
// listing with a red toast ("index 2 out of range") over an empty explorer, which
// said nothing about which edit was at fault and hid every other file.
//
// Where such an item IS reported is the review dialog (changeset.Preview names it
// with its parameter, instance, file and path), and submit still refuses it.
func TestFileListSurvivesAnUnwritableDraftItem(t *testing.T) {
	root := minimalRepo(t)
	// A second parameter mapped at a position that does not exist in the file:
	// the shape a stale mapping has after the file was edited outside Configer.
	cat := filepath.Join(root, ".configer", "parameters.yaml")
	b, err := os.ReadFile(cat)
	if err != nil {
		t.Fatal(err)
	}
	extra := `  - id: p-third
    name: app.servers.third
    category: General
    type: string
    scope: instance
    bindings:
      - { file: "{folder}/values.yaml", path: "$.app.servers[2].host", format: yaml }
`
	if err := os.WriteFile(cat, append(b, []byte(extra)...), 0o644); err != nil {
		t.Fatal(err)
	}
	// Committed, so the review preview (which builds against the base branch)
	// knows the parameter too.
	for _, args := range [][]string{
		{"add", "-A"},
		{"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "stale mapping"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}

	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	// Stage an ordinary edit on it. Staging records intent; nothing is written.
	var staged struct {
		OK      bool `json:"ok"`
		Pending int  `json:"pending"`
	}
	doJSON(t, h, http.MethodPut, "/api/values", map[string]any{
		"instance": "staging", "paramId": "p-third", "value": "h3.example.com",
	}, &staged)
	if !staged.OK || staged.Pending == 0 {
		t.Fatalf("the edit did not stage: %+v", staged)
	}

	var render struct {
		Files []struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		} `json:"files"`
	}
	doJSON(t, h, http.MethodGet, "/api/render/staging", nil, &render)
	if len(render.Files) == 0 {
		t.Fatal("the explorer came back empty because one staged edit could not be previewed")
	}
	var seen bool
	for _, f := range render.Files {
		if f.Path != "instances/staging/values.yaml" {
			continue
		}
		seen = true
		// The file is shown as it stands: the unwritable item is skipped, not
		// half-applied.
		if want := "app:\n  port: 8080\n"; f.Content != want {
			t.Errorf("content = %q, want the committed file %q", f.Content, want)
		}
	}
	if !seen {
		t.Fatalf("instances/staging/values.yaml missing from the listing: %+v", render.Files)
	}

	// And the item really is unwritable - otherwise this test proves nothing.
	// The review dialog is where it gets named.
	var draft struct {
		Draft struct{ ID int } `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &draft)
	var preview struct {
		Problems []struct {
			ParamID string `json:"paramId"`
			Message string `json:"message"`
		} `json:"problems"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/"+strconv.Itoa(draft.Draft.ID)+"/preview", nil, &preview)
	if len(preview.Problems) != 1 || preview.Problems[0].ParamID != "p-third" {
		t.Fatalf("the review preview should name the one item it cannot write, got %+v", preview.Problems)
	}
	// Said in words about the file, not about a slice.
	for _, bad := range []string{"index", "out of range"} {
		if strings.Contains(preview.Problems[0].Message, bad) {
			t.Errorf("message still speaks in Go terms (%q): %s", bad, preview.Problems[0].Message)
		}
	}
	if !strings.Contains(preview.Problems[0].Message, "values.yaml") {
		t.Errorf("message does not name the file: %s", preview.Problems[0].Message)
	}
}
