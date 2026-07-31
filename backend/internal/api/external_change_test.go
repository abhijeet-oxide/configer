package api

// Bidirectional sync: what Configer sees when the repository changes WITHOUT
// it.
//
// The product's central claim is that it is a wrapper over an ordinary Git
// repository - what Configer writes goes straight to Git, and what Git
// receives from anywhere else is just as real. These tests are that claim,
// made checkable. Every one of them changes the repository the way a
// colleague's editor or a pipeline would (write files, `git commit`, no
// Configer API involved) and then asks Configer what it knows.

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// externalRepo is a managed application with one instance, a base layer and a
// declared software version: enough for an outsider to add a second instance,
// change a value, or ship a new release into it.
func externalRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeFiles(t, root, map[string]string{
		".configer/application.yaml": "apiVersion: configer.io/v1\nkind: Application\nname: t\nlayout: plain-folders\n",
		".configer/parameters.yaml": `
apiVersion: configer.io/v1
kind: ParameterCatalog
parameters:
  - id: p-port
    name: app.port
    category: General
    type: integer
    scope: instance
    bindings:
      - { file: "{folder}/values.yaml", path: $.app.port, format: yaml }
  - id: p-name
    name: app.name
    category: General
    type: string
    scope: instance
    bindings:
      - { file: "{folder}/values.yaml", path: $.app.name, format: yaml }
`,
		".configer/instances.yaml": "apiVersion: configer.io/v1\nkind: InstanceRegistry\n" +
			"instances:\n  - { name: staging, folder: instances/staging, softwareVersion: v1.0.0 }\n",
		".configer/ignore.yaml":         "apiVersion: configer.io/v1\nkind: Ignore\nfiles: []\nparameters: []\n",
		"instances/staging/values.yaml": "app:\n  port: 8080\n  name: demo\n",
		"shared/values.yaml":            "app:\n  tier: gold\n",
	})
	git(t, root, "init", "-q", "-b", "main")
	git(t, root, "add", "-A")
	git(t, root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
	return root
}

func writeFiles(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func git(t *testing.T, root string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = root
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
}

// externalCommit is somebody else changing the repository: files land in the
// working tree and are committed under their name, with no Configer call
// anywhere in the path.
func externalCommit(t *testing.T, root, author, message string, files map[string]string) {
	t.Helper()
	writeFiles(t, root, files)
	git(t, root, "add", "-A")
	git(t, root, "-c", "user.name="+author, "-c", "user.email="+author+"@example.com",
		"commit", "-q", "-m", message)
}

// externalDelete is somebody else removing part of the repository.
func externalDelete(t *testing.T, root, author, message string, paths ...string) {
	t.Helper()
	for _, p := range paths {
		if err := os.RemoveAll(filepath.Join(root, filepath.FromSlash(p))); err != nil {
			t.Fatal(err)
		}
	}
	git(t, root, "add", "-A")
	git(t, root, "-c", "user.name="+author, "-c", "user.email="+author+"@example.com",
		"commit", "-q", "-m", message)
}

// watching starts a server and takes the first look, which baselines "now" so
// that only what happens next reads as news - exactly what a user's first
// visit to the Repository changes tab does.
func watching(t *testing.T, root string) http.Handler {
	t.Helper()
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()
	readFindings(t, h)
	return h
}

func readFindings(t *testing.T, h http.Handler) []Finding {
	t.Helper()
	var resp struct {
		Findings []Finding `json:"findings"`
	}
	doJSON(t, h, http.MethodGet, "/api/repo/findings", nil, &resp)
	return resp.Findings
}

func findingsOfType(list []Finding, kind string) []Finding {
	var out []Finding
	for _, f := range list {
		if f.Type == kind {
			out = append(out, f)
		}
	}
	return out
}

func onlyFinding(t *testing.T, list []Finding, kind string) Finding {
	t.Helper()
	got := findingsOfType(list, kind)
	if len(got) != 1 {
		t.Fatalf("want exactly one %s finding, got %d in %s", kind, len(got), render(list))
	}
	return got[0]
}

func render(list []Finding) string {
	var b strings.Builder
	b.WriteString("[")
	for i, f := range list {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteString(f.Type + " " + f.Path)
	}
	b.WriteString("]")
	return b.String()
}

// A value changed on Git by somebody else IS the value Configer shows. No
// import, no acknowledgement, no reconciliation step: the repository is the
// source of truth and the grid is a view of it.
func TestExternalValueEditIsWhatTheGridShows(t *testing.T) {
	root := externalRepo(t)
	h := watching(t, root)

	externalCommit(t, root, "dana", "raise the staging port", map[string]string{
		"instances/staging/values.yaml": "app:\n  port: 9999\n  name: demo\n",
	})

	var g struct {
		Rows []struct {
			Param struct {
				ID string `json:"id"`
			} `json:"param"`
			Cells map[string]struct {
				Value any `json:"value"`
			} `json:"cells"`
		} `json:"rows"`
	}
	doJSON(t, h, http.MethodGet, "/api/grid", nil, &g)
	for _, row := range g.Rows {
		if row.Param.ID != "p-port" {
			continue
		}
		if got := row.Cells["staging"].Value; got != float64(9999) {
			t.Fatalf("grid shows %v for a value another developer committed, want 9999", got)
		}
	}

	// And it is reported as drift on a managed file, naming the parameter and
	// the person who did it.
	f := onlyFinding(t, readFindings(t, h), FindingFileChanged)
	if f.Path != "instances/staging/values.yaml" {
		t.Errorf("path = %q", f.Path)
	}
	// Both parameters are sourced from this file, so both are named: the
	// finding says what the change could have touched, not what it did.
	if len(f.Params) != 2 || f.Params[0] != "p-port" {
		t.Errorf("params = %v, want both parameters bound to the file", f.Params)
	}
	if f.Commit == nil || f.Commit.Author != "dana" {
		t.Fatalf("finding does not say who changed it: %+v", f.Commit)
	}
	if f.Commit.Message != "raise the staging port" || f.Commit.Date == "" || f.Commit.Short == "" {
		t.Errorf("provenance incomplete: %+v", f.Commit)
	}
}

// Somebody stands up a whole new site on Git. Configer must report it as ONE
// instance that appeared - named, with the registry entry adopting it would
// create - not as a heap of new files for the user to piece together.
func TestExternalNewInstanceIsOfferedForManagement(t *testing.T) {
	root := externalRepo(t)
	h := watching(t, root)

	externalCommit(t, root, "ravi", "stand up prod-eu", map[string]string{
		"instances/prod-eu/values.yaml":  "app:\n  port: 8080\n  name: prod\n  timeout: 30\n",
		"instances/prod-eu/network.yaml": "network:\n  vlan: 44\n",
	})

	list := readFindings(t, h)
	f := onlyFinding(t, list, FindingNewInstance)
	if f.Instance != "prod-eu" {
		t.Errorf("instance = %q, want prod-eu", f.Instance)
	}
	if f.Path != "instances/prod-eu/" {
		t.Errorf("path = %q, want instances/prod-eu/", f.Path)
	}
	if f.Proposed == nil || f.Proposed.Folder != "instances/prod-eu" {
		t.Fatalf("no adoptable registry entry proposed: %+v", f.Proposed)
	}
	if f.Candidates == 0 {
		t.Error("candidates = 0; the offer should say how much configuration is in there")
	}
	if len(f.Files) != 2 {
		t.Errorf("files = %v, want both config files in the folder", f.Files)
	}
	if f.Commit == nil || f.Commit.Author != "ravi" || f.Commit.Message != "stand up prod-eu" {
		t.Fatalf("finding does not say who added the instance: %+v", f.Commit)
	}
	// The new site is one event. Its files must not also be reported one by
	// one, or the important news drowns in the noise it caused.
	if n := len(findingsOfType(list, FindingNewFile)); n != 0 {
		t.Errorf("%d loose new_file findings for a folder already explained: %s", n, render(list))
	}
	if n := len(findingsOfType(list, FindingNewFolder)); n != 0 {
		t.Errorf("%d new_folder findings duplicating the new instance: %s", n, render(list))
	}

	// It is the FIRST thing reported: an instance outranks any file.
	if list[0].Type != FindingNewInstance {
		t.Errorf("first finding is %s; estate-level news belongs at the top", list[0].Type)
	}
}

// An offered instance can be taken over: one call stages an ordinary
// structural draft item pointing at the folder that already exists. Nothing is
// copied and nothing is written into the tree, and the grid previews the new
// column immediately.
func TestAdoptingAnExternalInstanceStagesADraft(t *testing.T) {
	root := externalRepo(t)
	h := watching(t, root)
	externalCommit(t, root, "ravi", "stand up prod-eu", map[string]string{
		"instances/prod-eu/values.yaml": "app:\n  port: 8080\n  name: prod\n",
	})
	f := onlyFinding(t, readFindings(t, h), FindingNewInstance)

	doJSON(t, h, http.MethodPost, "/api/instances", map[string]any{
		"name":        f.Proposed.Name,
		"folder":      f.Proposed.Folder,
		"environment": f.Proposed.Environment,
	}, nil)

	items := draftItems(t, h)
	if len(items) != 1 {
		t.Fatalf("draft has %d items, want the one add-instance", len(items))
	}
	meta, _ := json.Marshal(items[0].New)
	if !strings.Contains(string(meta), "instances/prod-eu") {
		t.Fatalf("staged instance does not point at the existing folder: %s", meta)
	}

	// The pending column reads the folder that is already there, so its cells
	// show the values the other developer committed rather than blanks. Seeing
	// what they actually configured is the whole reason for taking it over.
	var g struct {
		Rows []struct {
			Param struct {
				ID string `json:"id"`
			} `json:"param"`
			Cells map[string]struct {
				Value   any    `json:"value"`
				Set     bool   `json:"set"`
				File    string `json:"file"`
				Pending bool   `json:"pending"`
			} `json:"cells"`
		} `json:"rows"`
	}
	doJSON(t, h, http.MethodGet, "/api/grid", nil, &g)
	found := false
	for _, row := range g.Rows {
		if row.Param.ID != "p-name" {
			continue
		}
		cell, ok := row.Cells["prod-eu"]
		if !ok {
			t.Fatal("the adopted instance has no column in the grid preview")
		}
		found = true
		if !cell.Pending {
			t.Error("the adopted column should read as pending until the change is published")
		}
		if !cell.Set || cell.Value != "prod" {
			t.Errorf("adopted cell = %v (set %v), want the value already in the folder", cell.Value, cell.Set)
		}
		if cell.File != "instances/prod-eu/values.yaml" {
			t.Errorf("adopted cell reads %q, want the folder that already exists", cell.File)
		}
	}
	if !found {
		t.Fatal("p-name row missing")
	}
}

// A folder an ignore rule covers is a decision already made, and must not keep
// asking.
func TestIgnoredFolderIsNotOfferedAsAnInstance(t *testing.T) {
	root := externalRepo(t)
	externalCommit(t, root, "ravi", "add a template folder", map[string]string{
		".configer/ignore.yaml":           "apiVersion: configer.io/v1\nkind: Ignore\nfiles:\n  - instances/_template/*\nparameters: []\n",
		"instances/_template/values.yaml": "app:\n  port: 0\n  name: template\n",
	})
	h := watching(t, root)
	if got := findingsOfType(readFindings(t, h), FindingNewInstance); len(got) != 0 {
		t.Fatalf("an ignored folder was still offered: %+v", got)
	}
}

// New settings inside a file Configer already manages are a SCHEMA change, and
// the most easily missed kind of drift: the file is known, so nothing looks
// new, while the keys nobody has decided about pile up inside it.
func TestExternalSchemaChangeSurfacesNewSettings(t *testing.T) {
	root := externalRepo(t)
	h := watching(t, root)

	externalCommit(t, root, "mira", "ship the retry feature", map[string]string{
		"instances/staging/values.yaml": "app:\n  port: 8080\n  name: demo\n" +
			"retry:\n  enabled: true\n  attempts: 5\n",
	})

	f := onlyFinding(t, readFindings(t, h), FindingNewParameters)
	if f.Path != "instances/staging/values.yaml" {
		t.Errorf("path = %q", f.Path)
	}
	if f.Candidates < 2 {
		t.Errorf("candidates = %d, want the two new keys", f.Candidates)
	}
	if len(f.Params) == 0 {
		t.Error("the finding should still name the parameters the file already carries")
	}
	if f.Commit == nil || f.Commit.Author != "mira" {
		t.Fatalf("provenance missing: %+v", f.Commit)
	}
	// A schema change is not plain value drift, and must not be reported as
	// both.
	if n := len(findingsOfType(readFindings(t, h), FindingFileChanged)); n != 0 {
		t.Errorf("%d file_changed findings duplicating the schema change", n)
	}
}

// A software version arriving is the event the whole version-aware grid exists
// to serve, and it can arrive from anywhere: an upgrade pipeline, another
// team, a release drop.
func TestExternalVersionBumpIsReported(t *testing.T) {
	root := externalRepo(t)
	h := watching(t, root)

	externalCommit(t, root, "pipeline", "upgrade staging to v2.0.0", map[string]string{
		".configer/instances.yaml": "apiVersion: configer.io/v1\nkind: InstanceRegistry\n" +
			"instances:\n  - { name: staging, folder: instances/staging, softwareVersion: v2.0.0 }\n",
	})

	f := onlyFinding(t, readFindings(t, h), FindingVersionChanged)
	if f.Instance != "staging" {
		t.Errorf("instance = %q", f.Instance)
	}
	if f.From != "v1.0.0" || f.To != "v2.0.0" {
		t.Errorf("version move = %q -> %q, want v1.0.0 -> v2.0.0", f.From, f.To)
	}
	if f.Commit == nil || f.Commit.Author != "pipeline" {
		t.Fatalf("provenance missing: %+v", f.Commit)
	}

	// Acknowledging re-baselines, so the same move is not re-reported forever.
	doJSON(t, h, http.MethodPost, "/api/repo/findings/ack", nil, nil)
	if got := findingsOfType(readFindings(t, h), FindingVersionChanged); len(got) != 0 {
		t.Fatalf("an acknowledged version move came back: %+v", got)
	}
}

// An instance deleted on Git is one loss, not a list of vanished files.
func TestExternalInstanceRemovalIsReportedOnce(t *testing.T) {
	root := externalRepo(t)
	externalCommit(t, root, "ravi", "stand up prod-eu", map[string]string{
		".configer/instances.yaml": "apiVersion: configer.io/v1\nkind: InstanceRegistry\ninstances:\n" +
			"  - { name: staging, folder: instances/staging, softwareVersion: v1.0.0 }\n" +
			"  - { name: prod-eu, folder: instances/prod-eu, softwareVersion: v1.0.0 }\n",
		"instances/prod-eu/values.yaml": "app:\n  port: 8080\n  name: prod\n",
	})
	h := watching(t, root)

	externalDelete(t, root, "ravi", "decommission prod-eu", "instances/prod-eu")

	list := readFindings(t, h)
	f := onlyFinding(t, list, FindingInstanceGone)
	if f.Instance != "prod-eu" {
		t.Errorf("instance = %q", f.Instance)
	}
	if n := len(findingsOfType(list, FindingFileDeleted)); n != 0 {
		t.Errorf("%d file_deleted findings for an instance already reported gone: %s", n, render(list))
	}
	if list[0].Type != FindingInstanceGone {
		t.Errorf("first finding is %s; a lost instance is the most urgent thing here", list[0].Type)
	}
}

// New configuration files that are NOT an instance folder still get reported,
// and the folder finding names the folder they actually landed in rather than
// the bucket above it.
func TestNewFilesOutsideAnInstanceNameTheirOwnFolder(t *testing.T) {
	root := externalRepo(t)
	h := watching(t, root)

	externalCommit(t, root, "sam", "add the v2 defaults drop", map[string]string{
		"defaults/v2/limits.yaml":  "limits:\n  cpu: 500m\n",
		"defaults/v2/network.yaml": "network:\n  mtu: 9000\n",
	})

	list := readFindings(t, h)
	f := onlyFinding(t, list, FindingNewFolder)
	if f.Path != "defaults/v2/" {
		t.Fatalf("folder finding says %q; it must name the folder the files landed in, not the bucket above it", f.Path)
	}
	if n := len(findingsOfType(list, FindingNewFile)); n != 2 {
		t.Errorf("new_file findings = %d, want 2", n)
	}
}

// Adopting a folder is a promise that its values become this instance's
// values, so the promise is checked before it is staged.
func TestAdoptionRefusesAFolderItCannotKeep(t *testing.T) {
	root := externalRepo(t)
	h := watching(t, root)

	cases := []struct {
		name string
		body map[string]any
		want string
	}{
		{"missing folder", map[string]any{"name": "ghost", "folder": "instances/nope"}, "not a folder"},
		{"escaping the repository", map[string]any{"name": "esc", "folder": "../secrets"}, "inside this repository"},
		{"already managed", map[string]any{"name": "dupe", "folder": "instances/staging"}, "already managed as staging"},
		{"folder and clone together", map[string]any{"name": "both", "folder": "instances/staging", "cloneFrom": "staging"}, "not both"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := doRaw(t, h, http.MethodPost, "/api/instances", tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.want) {
				t.Errorf("message %s does not explain the problem (%q)", rec.Body.String(), tc.want)
			}
		})
	}
}
