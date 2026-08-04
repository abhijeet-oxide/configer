package pathedit

import (
	"strings"
	"testing"
)

// The XML copy is BYTES: the block's own text, comments and indentation, spliced
// in after the last sibling of its kind. Everything else in the document has to
// come through untouched, or a "duplicate this network" reflows a file nobody
// asked to reformat.
func TestDuplicateXMLEntryIsAByteCopyAppendedLast(t *testing.T) {
	doc := `<config>
  <cloud-deployment-config>
    <net-info>
      <net-label>internal-control</net-label>
      <net-id>ctl0</net-id>
    </net-info>
    <!-- the media network -->
    <net-info>
      <net-label>internal-media</net-label>
      <net-id>imed0</net-id>
    </net-info>
    <net-info>
      <net-label>trustedsig</net-label>
      <net-id>tsig0</net-id>
    </net-info>
  </cloud-deployment-config>
</config>
`
	out, newPath, err := DuplicateEntry([]byte(doc), "xml",
		"/config/cloud-deployment-config/net-info[2]")
	if err != nil {
		t.Fatal(err)
	}
	// The copy is the LAST entry, so no existing entry is renumbered: [1] and
	// [2] still read what they read before.
	if newPath != "/config/cloud-deployment-config/net-info[4]" {
		t.Fatalf("newPath = %q, want net-info[4]", newPath)
	}
	if v, _, _ := Get([]byte(out), "xml", "/config/cloud-deployment-config/net-info[1]/net-label"); v != "internal-control" {
		t.Errorf("entry 1 moved: %v", v)
	}
	if v, _, _ := Get([]byte(out), "xml", "/config/cloud-deployment-config/net-info[3]/net-label"); v != "trustedsig" {
		t.Errorf("entry 3 moved: %v", v)
	}
	if v, _, _ := Get([]byte(out), "xml", newPath+"/net-label"); v != "internal-media" {
		t.Errorf("the copy carries %v, want internal-media", v)
	}
	// Byte fidelity: the original document is still a literal prefix-by-lines of
	// the result, comment included.
	if !strings.Contains(out, "<!-- the media network -->") {
		t.Errorf("comment lost:\n%s", out)
	}
	before := strings.Index(doc, "</cloud-deployment-config>")
	if out[:before] != doc[:before] {
		t.Errorf("bytes before the insertion changed:\n%s", out)
	}
	// The copy sits at its siblings' indentation, on its own line.
	if !strings.Contains(out, "\n    <net-info>\n      <net-label>internal-media") {
		t.Errorf("copy is not indented like its siblings:\n%s", out)
	}
	if se := CheckSyntax([]byte(out), "xml"); se != nil {
		t.Errorf("result does not parse: %v", se)
	}
}

// A YAML list entry duplicates through the node tree, appended last, with the
// file's own indentation and its blank lines intact.
func TestDuplicateYAMLListEntry(t *testing.T) {
	doc := `# fleet
servers:
  - name: a
    port: 8080

  - name: b
    port: 8081
other: keep
`
	out, newPath, err := DuplicateEntry([]byte(doc), "yaml", "$.servers[1]")
	if err != nil {
		t.Fatal(err)
	}
	if newPath != "$.servers[2]" {
		t.Fatalf("newPath = %q", newPath)
	}
	if v, _, _ := Get([]byte(out), "yaml", "$.servers[2].name"); v != "b" {
		t.Errorf("copy carries %v, want b", v)
	}
	if v, _, _ := Get([]byte(out), "yaml", "$.servers[0].name"); v != "a" {
		t.Errorf("entry 0 moved: %v", v)
	}
	for _, keep := range []string{"# fleet", "other: keep"} {
		if !strings.Contains(out, keep) {
			t.Errorf("lost %q:\n%s", keep, out)
		}
	}
}

// An entry addressed by an identity key cannot be duplicated into a second
// entry with the same identity, and the refusal has to say why in words the
// person can act on.
func TestDuplicateRefusesAKeyedEntry(t *testing.T) {
	doc := "env:\n  - name: LOG_LEVEL\n    value: info\n"
	_, _, err := DuplicateEntry([]byte(doc), "yaml", "$.env[name=LOG_LEVEL]")
	if err == nil {
		t.Fatal("a keyed entry was duplicated")
	}
	if !strings.Contains(err.Error(), "name") || !strings.Contains(err.Error(), "own") {
		t.Errorf("refusal does not explain itself: %v", err)
	}
}

// Nothing is copied out of a file that does not parse: the copy would carry the
// damage with it, twice.
func TestDuplicateRefusesABrokenFile(t *testing.T) {
	_, _, err := DuplicateEntry([]byte("<config><a></b></config>"), "xml", "/config/a[1]")
	if err == nil || !strings.Contains(err.Error(), "does not parse") {
		t.Fatalf("err = %v, want a parse refusal", err)
	}
}

// A JSON list entry duplicates with key order and the file's indentation kept.
func TestDuplicateJSONListEntry(t *testing.T) {
	doc := "{\n  \"servers\": [\n    { \"name\": \"a\", \"port\": 1 },\n    { \"name\": \"b\", \"port\": 2 }\n  ]\n}\n"
	out, newPath, err := DuplicateEntry([]byte(doc), "json", "$.servers[0]")
	if err != nil {
		t.Fatal(err)
	}
	if newPath != "$.servers[2]" {
		t.Fatalf("newPath = %q", newPath)
	}
	if v, _, _ := Get([]byte(out), "json", "$.servers[2].name"); v != "a" {
		t.Errorf("copy carries %v, want a", v)
	}
	if se := CheckSyntax([]byte(out), "json"); se != nil {
		t.Errorf("result does not parse: %v", se)
	}
	if i := strings.Index(out, `"name"`); i < 0 || strings.Index(out, `"port"`) < i {
		t.Errorf("key order lost:\n%s", out)
	}
}
