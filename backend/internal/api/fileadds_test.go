package api

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/discovery"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/parsers"
	"github.com/abhijeet-oxide/configer/backend/internal/pathedit"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/writer"
)

// draftOwnerName is whose draft these requests touch. Single-user mode maps
// every request to the one local operator, so CurrentDraft("") is ALWAYS nil -
// which quietly turned two assertions here into assertions about nothing.
const draftOwnerName = "Local user"

// A direct file edit that ADDS settings used to vanish into "edited directly":
// the new values were in the staged bytes, absent from the grid, and unnamed in
// the review. They are now staged as parameters the change starts managing, so
// they appear where settings appear.
func TestFileEditStagesNewParametersItFound(t *testing.T) {
	root := minimalRepo(t) // instances/staging/values.yaml: app.port 8080, bound as p1
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	var res struct {
		Kind          string `json:"kind"`
		NewParameters int    `json:"newParameters"`
	}
	doJSON(t, h, http.MethodPut, "/api/files/draft", map[string]any{
		"instance": "staging",
		"path":     "instances/staging/values.yaml",
		"content":  "app:\n  port: 8080\n  host: edge-1\nlogging:\n  level: debug\n",
	}, &res)
	if res.Kind != "file" {
		t.Fatalf("kind = %q, want file (unmanaged content changed)", res.Kind)
	}
	if res.NewParameters != 2 {
		t.Fatalf("newParameters = %d, want 2 (app.host and logging.level)", res.NewParameters)
	}

	// The grid shows them as pending additions, with the value the edit put in
	// the file - which is not on disk yet.
	var g struct {
		Rows []struct {
			Param struct {
				ID       string `json:"id"`
				Name     string `json:"name"`
				Scope    string `json:"scope"`
				Bindings []struct {
					File string `json:"file"`
					Path string `json:"path"`
				} `json:"bindings"`
			} `json:"param"`
			Cells map[string]struct {
				Value   any  `json:"value"`
				Set     bool `json:"set"`
				Pending bool `json:"pending"`
			} `json:"cells"`
			PendingAdd bool `json:"pendingAdd"`
		} `json:"rows"`
	}
	doJSON(t, h, http.MethodGet, "/api/grid", nil, &g)
	found := map[string]bool{}
	for _, row := range g.Rows {
		if !row.PendingAdd {
			continue
		}
		found[row.Param.Name] = true
		cell := row.Cells["staging"]
		if !cell.Pending || !cell.Set {
			t.Errorf("%s cell = %+v, want a pending, set cell", row.Param.Name, cell)
		}
		if row.Param.Scope != "instance" {
			t.Errorf("%s scope = %q, want instance (the file is inside the instance folder)", row.Param.Name, row.Param.Scope)
		}
		if len(row.Param.Bindings) != 1 || row.Param.Bindings[0].File != "{folder}/values.yaml" {
			t.Errorf("%s bindings = %+v, want one templated binding", row.Param.Name, row.Param.Bindings)
		}
	}
	if !found["app.host"] || !found["logging.level"] {
		t.Fatalf("pending additions = %v, want app.host and logging.level", found)
	}

	// Saving again with those lines removed withdraws the proposals rather than
	// leaving parameters bound to keys the file no longer has.
	doJSON(t, h, http.MethodPut, "/api/files/draft", map[string]any{
		"instance": "staging",
		"path":     "instances/staging/values.yaml",
		"content":  "app:\n  port: 8080\n  host: edge-1\n",
	}, &res)
	if res.NewParameters != 1 {
		t.Fatalf("after removing logging.level, newParameters = %d, want 1", res.NewParameters)
	}
}

// An edit that only touches values the catalog already manages stays a value
// edit: nothing is "new", so nothing is proposed.
func TestFileEditOfManagedValueProposesNothing(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	var res struct {
		Kind          string `json:"kind"`
		Staged        int    `json:"staged"`
		NewParameters int    `json:"newParameters"`
	}
	doJSON(t, h, http.MethodPut, "/api/files/draft", map[string]any{
		"instance": "staging",
		"path":     "instances/staging/values.yaml",
		"content":  "app:\n  port: 9090\n",
	}, &res)
	if res.Kind != "values" || res.Staged != 1 || res.NewParameters != 0 {
		t.Fatalf("res = %+v, want one value item and no proposals", res)
	}
}

// Undoing the file edit takes the parameters it proposed with it: they exist
// only because those lines do.
func TestUndoingAFileEditWithdrawsItsParameters(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	doJSON(t, h, http.MethodPut, "/api/files/draft", map[string]any{
		"instance": "staging",
		"path":     "instances/staging/values.yaml",
		"content":  "app:\n  port: 8080\n  host: edge-1\n",
	}, nil)
	doJSON(t, h, http.MethodDelete,
		"/api/values?paramId=file:instances/staging/values.yaml&instance=staging", nil, nil)

	if d := s.Store.CurrentDraft(draftOwnerName); d != nil && len(d.Items) != 0 {
		t.Fatalf("draft still holds %+v after undoing the file edit", d.Items)
	}
}

// A file that no longer parses is refused outright - nothing staged - and the
// refusal says WHERE, because "the file does not parse" alone sends the reader
// hunting through the whole file.
func TestFileEditRefusesABrokenFileAndSaysWhere(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	rec := doRaw(t, h, http.MethodPut, "/api/files/draft", map[string]any{
		"instance": "staging",
		"path":     "instances/staging/values.yaml",
		"content":  "app:\n  port: 8080\n   name: demo\n",
	})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body.String())
	}
	var e struct {
		Error  string `json:"error"`
		Syntax struct {
			File    string `json:"file"`
			Line    int    `json:"line"`
			Snippet string `json:"snippet"`
		} `json:"syntax"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
		t.Fatal(err)
	}
	if e.Syntax.Line != 3 {
		t.Errorf("syntax.line = %d, want 3 (%s)", e.Syntax.Line, rec.Body.String())
	}
	if e.Syntax.File != "instances/staging/values.yaml" || e.Syntax.Snippet != "name: demo" {
		t.Errorf("syntax = %+v", e.Syntax)
	}
	if !strings.Contains(e.Error, "nothing was staged") {
		t.Errorf("message does not say the edit was refused: %q", e.Error)
	}
	if d := s.Store.CurrentDraft(draftOwnerName); d != nil && len(d.Items) > 0 {
		t.Errorf("a broken file was staged anyway: %+v", d.Items)
	}
}

// A file that is not one of the formats we parse is not "invalid YAML": it was
// never YAML. A README saves like any other file.
func TestFileEditDoesNotSyntaxCheckProse(t *testing.T) {
	root := minimalRepo(t)
	if err := os.WriteFile(filepath.Join(root, "instances", "staging", "README.md"),
		[]byte("# Staging\n\nNote: this is prose.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	doJSON(t, s.Routes(), http.MethodPut, "/api/files/draft", map[string]any{
		"instance": "staging",
		"path":     "instances/staging/README.md",
		"content":  "# Staging\n\nNote: this is prose, and: it has colons.\n",
	}, nil)
}

// Duplicating a list entry stages the copy as an ordinary file edit plus the
// parameters it brought with it - the same road a hand edit travels.
func TestDuplicateEntryStagesTheCopyAndItsParameters(t *testing.T) {
	root := minimalRepo(t)
	if err := os.WriteFile(filepath.Join(root, "instances", "staging", "net.xml"),
		[]byte("<config>\n  <net-info>\n    <label>a</label>\n  </net-info>\n  <net-info>\n    <label>b</label>\n  </net-info>\n</config>\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	var res struct {
		NewPath       string `json:"newPath"`
		NewParameters int    `json:"newParameters"`
	}
	doJSON(t, h, http.MethodPost, "/api/files/duplicate", map[string]any{
		"instance": "staging", "file": "instances/staging/net.xml",
		"path": "/config/net-info[1]",
	}, &res)
	if res.NewPath != "/config/net-info[3]" {
		t.Fatalf("newPath = %q, want net-info[3] (appended, not inserted)", res.NewPath)
	}
	if res.NewParameters != 1 {
		t.Fatalf("newParameters = %d, want 1 (the copy's label)", res.NewParameters)
	}

	// The copy is in the draft's file bytes with the source entry's value, and
	// the entries that were already there did not move.
	var files struct {
		Files []struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		} `json:"files"`
	}
	doJSON(t, h, http.MethodGet, "/api/render/staging", nil, &files)
	var content string
	for _, f := range files.Files {
		if f.Path == "instances/staging/net.xml" {
			content = f.Content
		}
	}
	if strings.Count(content, "<net-info>") != 3 {
		t.Fatalf("expected three entries:\n%s", content)
	}
	if !strings.HasPrefix(content, "<config>\n  <net-info>\n    <label>a</label>") {
		t.Errorf("the entries above the copy were rewritten:\n%s", content)
	}
}

// The case from the field: somebody adds ONE network in the middle of an XML
// file that already has several. Comparing the two versions by path tells them
// they added six settings, leaves two parameters bound to nothing, and silently
// re-points eight more at a different network than their name says. All three
// are the same bug - these entries are addressed by position - and all three
// have to be gone.
func TestInsertingAnEntryMidFileReportsWhatWasActuallyAdded(t *testing.T) {
	const netXML = `<config>
  <cloud-deployment-config>
    <net-info>
      <net-label>trustedv4mngt</net-label>
      <net-id>oam</net-id>
      <device-name-ipvlan>vlan100</device-name-ipvlan>
    </net-info>
    <net-info>
      <net-label>trustedsig</net-label>
      <net-id>tsig0</net-id>
      <device-name-ipvlan>vlan340</device-name-ipvlan>
    </net-info>
    <net-info>
      <net-label>trustedmed</net-label>
      <net-id>tmed0</net-id>
    </net-info>
    <net-info>
      <net-label>untrustedmed</net-label>
      <net-id>umed0</net-id>
      <vlan-tag>-1</vlan-tag>
    </net-info>
  </cloud-deployment-config>
</config>
`
	root := minimalRepo(t)
	file := filepath.Join(root, "instances", "staging", "net.xml")
	if err := os.WriteFile(file, []byte(netXML), 0o644); err != nil {
		t.Fatal(err)
	}
	// Manage every setting in it, exactly as an import would.
	cands, err := parsers.XMLParser{}.Extract("instances/staging/net.xml", []byte(netXML))
	if err != nil {
		t.Fatal(err)
	}
	managed := discovery.Tunable("instances/staging/net.xml", cands)
	for i := range managed {
		managed[i].Scope = model.ScopeInstance
		managed[i].Bindings[0].File = "{folder}/net.xml"
		managed[i].Default = nil
	}
	if _, _, err := writer.AddParameters(root, managed); err != nil {
		t.Fatal(err)
	}
	commitAll(t, root, "add net.xml")
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()

	at := strings.Index(netXML, "    <net-info>\n      <net-label>trustedsig")
	edited := netXML[:at] + `    <net-info>
      <net-label>trustedv4mngt2</net-label>
      <net-id>oam2</net-id>
      <device-name-ipvlan>vlan101</device-name-ipvlan>
    </net-info>
` + netXML[at:]

	var res struct {
		NewParameters     int `json:"newParameters"`
		MovedParameters   int `json:"movedParameters"`
		DroppedParameters int `json:"droppedParameters"`
	}
	doJSON(t, h, http.MethodPut, "/api/files/draft", map[string]any{
		"instance": "staging", "path": "instances/staging/net.xml", "content": edited,
	}, &res)

	if res.NewParameters != 3 {
		t.Fatalf("newParameters = %d, want the 3 settings of the block that was typed in", res.NewParameters)
	}
	if res.DroppedParameters != 0 {
		t.Errorf("droppedParameters = %d; an insert deletes nothing", res.DroppedParameters)
	}
	if res.MovedParameters == 0 {
		t.Fatal("nothing moved, so every binding below the insert still points at the wrong network")
	}

	// The additions are the inserted block's own settings, at its own path.
	var g struct {
		Rows []struct {
			Param struct {
				Name     string `json:"name"`
				Bindings []struct{ Path string } `json:"bindings"`
			} `json:"param"`
			Cells      map[string]struct{ Value any } `json:"cells"`
			PendingAdd bool                           `json:"pendingAdd"`
		} `json:"rows"`
	}
	doJSON(t, h, http.MethodGet, "/api/grid", nil, &g)
	got := map[string]any{}
	for _, r := range g.Rows {
		if r.PendingAdd {
			got[r.Param.Name] = r.Cells["staging"].Value
			if !strings.Contains(r.Param.Bindings[0].Path, "net-info[2]/") {
				t.Errorf("%s binds at %s, want the inserted entry's own position",
					r.Param.Name, r.Param.Bindings[0].Path)
			}
		}
	}
	for name, want := range map[string]any{
		"config.cloud-deployment-config.net-info[2].net-label":          "trustedv4mngt2",
		"config.cloud-deployment-config.net-info[2].net-id":             "oam2",
		"config.cloud-deployment-config.net-info[2].device-name-ipvlan": "vlan101",
	} {
		if got[name] != want {
			t.Errorf("pending addition %s = %v, want %v (all: %v)", name, got[name], want, got)
		}
	}

	// The catalog follows: every parameter that moved is re-pointed at the entry
	// it names, so nothing is left describing a different network.
	var d struct {
		Draft struct {
			Items []struct {
				Action string          `json:"action"`
				New    json.RawMessage `json:"new"`
			} `json:"items"`
		} `json:"draft"`
	}
	doJSON(t, h, http.MethodGet, "/api/changes/draft", nil, &d)
	var moves []writer.BindingMove
	for _, it := range d.Draft.Items {
		if it.Action != "realign-bindings" {
			continue
		}
		var payload change.RealignPayload
		if err := json.Unmarshal(it.New, &payload); err != nil {
			t.Fatal(err)
		}
		for _, m := range payload.Moves {
			moves = append(moves, writer.BindingMove{ParamID: m.ParamID, From: m.From, To: m.To})
		}
		if len(payload.Dropped) != 0 {
			t.Errorf("an insert dropped %d parameters", len(payload.Dropped))
		}
	}
	if _, _, err := writer.RealignBindings(root, moves, nil); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}
	p, err := project.Load(root)
	if err != nil {
		t.Fatal(err)
	}
	// trustedsig was entry 2 and is now entry 3: its parameters followed it, NAME
	// included. A binding that moves while its name stays put leaves two
	// parameters called net-info[2].net-label - the entry that moved, and the
	// entry that took its place - and the catalog refuses the second, so the
	// setting the person just typed in never arrives.
	byName := map[string]string{}
	for _, param := range p.Catalog.Parameters {
		if _, dup := byName[param.Name]; dup {
			t.Errorf("two parameters are called %s", param.Name)
		}
		byName[param.Name] = param.Bindings[0].Path
	}
	for name, wantPath := range map[string]string{
		"config.cloud-deployment-config.net-info[3].net-label": "/config/cloud-deployment-config/net-info[3]/net-label",
		"config.cloud-deployment-config.net-info[5].vlan-tag":  "/config/cloud-deployment-config/net-info[5]/vlan-tag",
	} {
		if byName[name] != wantPath {
			t.Errorf("%s binds to %q, want %q", name, byName[name], wantPath)
		}
	}
	// And the entry that moved still describes the network it always did.
	raw0, _ := os.ReadFile(file)
	if v, _, _ := pathedit.Get(raw0, "xml", byName["config.cloud-deployment-config.net-info[3].net-label"]); v != "trustedsig" {
		t.Errorf("net-info[3].net-label reads %v, want trustedsig (the network it has always named)", v)
	}
	// And nothing is bound to a path the file does not have.
	raw, _ := os.ReadFile(file)
	for _, param := range p.Catalog.Parameters {
		for _, b := range param.Bindings {
			if !strings.HasSuffix(b.File, "net.xml") {
				continue
			}
			if _, ok, _ := pathedit.Get(raw, "xml", b.Path); !ok {
				t.Errorf("%s is bound to %s, which the file does not have", param.Name, b.Path)
			}
		}
	}
}

func commitAll(t *testing.T, root, msg string) {
	t.Helper()
	for _, args := range [][]string{{"add", "-A"},
		{"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
}

// The undo beside a proposed parameter has to remove it. Such an item names a
// parameter AND the file it was found in, and addressing it by parameter alone
// found nothing - so the button did nothing at all, silently.
func TestUndoingOneProposedParameter(t *testing.T) {
	root := minimalRepo(t)
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Routes()
	doJSON(t, h, http.MethodPut, "/api/files/draft", map[string]any{
		"instance": "staging",
		"path":     "instances/staging/values.yaml",
		"content":  "app:\n  port: 8080\n  host: edge-1\nlogging:\n  level: debug\n",
	}, nil)

	before := len(s.Store.CurrentDraft(draftOwnerName).Items)
	doJSON(t, h, http.MethodDelete,
		"/api/values?paramId=logging-level&instance=staging", nil, nil)
	items := s.Store.CurrentDraft(draftOwnerName).Items
	if len(items) != before-1 {
		t.Fatalf("draft holds %d items, want one fewer than %d", len(items), before)
	}
	for _, it := range items {
		if it.ParamID == "logging-level" {
			t.Fatalf("the proposed parameter is still staged: %+v", it)
		}
	}
	// The file edit stays: the lines are still there, they are simply not
	// managed. Undoing a proposal is not undoing the typing.
	found := false
	for _, it := range items {
		if it.Act() == "edit-file" {
			found = true
		}
	}
	if !found {
		t.Error("undoing a proposed parameter took the file edit with it")
	}
}
