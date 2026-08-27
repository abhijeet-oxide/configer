package discovery

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// repo writes a throwaway repository and returns its root.
func repo(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for rel, body := range files {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func discover(t *testing.T, files map[string]string) Result {
	t.Helper()
	res, err := Discover(repo(t, files), registry(), project.Ignore{})
	if err != nil {
		t.Fatal(err)
	}
	return res
}

// catalogOrder lists the discovered parameters in the order discovery produced
// them.
func catalogOrder(res Result) []string {
	out := make([]string, 0, len(res.Parameters))
	for _, p := range res.Parameters {
		out = append(out, p.Name)
	}
	return out
}

func bindingPaths(p model.Parameter) []string {
	out := make([]string, 0, len(p.Bindings))
	for _, b := range p.Bindings {
		out = append(out, b.File+"|"+b.Path)
	}
	return out
}

func mustParam(t *testing.T, res Result, name string) model.Parameter {
	t.Helper()
	p, ok := paramsByName(res)[name]
	if !ok {
		t.Fatalf("%s missing; have %v", name, catalogOrder(res))
	}
	return p
}

// Two entries of a repeated structure are two entries, however alike they look.
// Discovery merges parameters that share a leaf name and a value, which is right
// across files and catastrophic inside one: a device list whose entries mostly
// say mode=normal collapsed into a single row that wrote every one of them, and
// the entries that lost their row disappeared from the tree entirely.
func TestEntriesOfOneRepeatedStructureStayApart(t *testing.T) {
	res := discover(t, map[string]string{
		"instances/site-a/net.xml": `<config>
  <interface>
    <label>north</label>
    <id>eth0</id>
    <mode>normal</mode>
  </interface>
  <interface>
    <label>south</label>
    <id>eth1</id>
    <mode>normal</mode>
  </interface>
  <interface>
    <label>east</label>
    <id>eth2</id>
    <mode>normal</mode>
  </interface>
</config>`,
	})

	for i, label := range []string{"north", "south", "east"} {
		entry := fmt.Sprintf("config.interface[%d]", i+1)
		mode := mustParam(t, res, entry+".mode")
		if len(mode.Bindings) != 1 {
			t.Errorf("%s.mode writes %v - one entry's mode must not write its neighbours", entry, bindingPaths(mode))
		}
		if got := mustParam(t, res, entry+".label").Default; got != label {
			t.Errorf("%s.label = %v, want %q", entry, got, label)
		}
	}
}

// Two unrelated blocks of one file that happen to agree are not one setting -
// and the merge did not only join them, it took the SHORTER name, so the row
// vanished from under the block it belongs to and turned up somewhere else.
func TestTwoBlocksInOneFileThatAgreeAreNotOneSetting(t *testing.T) {
	res := discover(t, map[string]string{
		"instances/site-a/net.xml": `<config>
  <interface>
    <label>north</label>
  </interface>
  <subnet>
    <label>north</label>
  </subnet>
</config>`,
	})

	iface := mustParam(t, res, "config.interface.label")
	subnet := mustParam(t, res, "config.subnet.label")
	if len(iface.Bindings) != 1 || len(subnet.Bindings) != 1 {
		t.Errorf("interface writes %v and subnet writes %v - neither may write the other",
			bindingPaths(iface), bindingPaths(subnet))
	}
}

// A limit and a request are different settings that routinely carry the same
// number, and they share a leaf name. Merged, raising the limit silently raised
// the request too - and linkResourceConstraints had nothing left to relate.
func TestALimitAndItsRequestAreTwoSettings(t *testing.T) {
	res := discover(t, map[string]string{
		"instances/site-a/values.yaml": `resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 500m
    memory: 512Mi
`,
	})

	for _, name := range []string{
		"resources.limits.cpu", "resources.requests.cpu",
		"resources.limits.memory", "resources.requests.memory",
	} {
		if got := len(mustParam(t, res, name).Bindings); got != 1 {
			t.Errorf("%s has %d bindings, want 1", name, got)
		}
	}
}

// The merge exists for a real shape and must keep working: one setting written
// into two different files of the same instance is ONE parameter with two
// bindings, so an edit reaches both.
func TestTheSameSettingInTwoFilesIsStillOneParameter(t *testing.T) {
	res := discover(t, map[string]string{
		"instances/site-a/values.yaml": "namespace: prod\n",
		"instances/site-a/net.xml":     "<config>\n  <namespace>prod</namespace>\n</config>\n",
	})

	ns := mustParam(t, res, "namespace")
	if len(ns.Bindings) != 2 {
		t.Fatalf("namespace writes %v, want both files", bindingPaths(ns))
	}
	files := ns.Bindings[0].File + " " + ns.Bindings[1].File
	if !strings.Contains(files, "values.yaml") || !strings.Contains(files, "net.xml") {
		t.Errorf("namespace bindings = %v", bindingPaths(ns))
	}
}

// The order of the catalog is the order of the FILE. Everything downstream -
// the grid table, the parameter tree, the review - reads it, so a catalog
// sorted by anything else means the editor disagrees with the document the
// reader is looking at.
func TestParametersArriveInTheOrderTheFileSpellsThem(t *testing.T) {
	res := discover(t, map[string]string{
		"instances/site-a/values.yaml": `zone: eu
alpha:
  port: 8080
  host: api.internal
beta: 3
`,
	})

	want := []string{"zone", "alpha.port", "alpha.host", "beta"}
	if got := catalogOrder(res); !equalStrings(got, want) {
		t.Errorf("order = %v, want the file's own order %v", got, want)
	}
}

// A repeated element folds into one list parameter, and the fold must not move
// it: the list belongs where its first element was, not at the end.
func TestAFoldedListKeepsItsPlaceInTheFile(t *testing.T) {
	res := discover(t, map[string]string{
		"instances/site-a/net.xml": `<config>
  <first>a</first>
  <pool>x</pool>
  <pool>y</pool>
  <last>z</last>
</config>`,
	})

	want := []string{"config.first", "config.pool", "config.last"}
	if got := catalogOrder(res); !equalStrings(got, want) {
		t.Errorf("order = %v, want %v", got, want)
	}
}

// With many files the question is the same one level up: each file's settings
// stay together, in the file's own order, and the files follow one another in a
// stable order rather than interleaving.
func TestEachFilesParametersStayTogetherAndInOrder(t *testing.T) {
	res := discover(t, map[string]string{
		"instances/site-a/a-first.yaml":  "zulu: 1\nalpha: 2\n",
		"instances/site-a/b-second.yaml": "yankee: 3\nbravo: 4\n",
	})

	want := []string{"zulu", "alpha", "yankee", "bravo"}
	if got := catalogOrder(res); !equalStrings(got, want) {
		t.Errorf("order = %v, want file by file, each in its own order %v", got, want)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
