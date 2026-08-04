package discovery

import (
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/parsers"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
)

const netInfoXML = `<config>
  <cloud-deployment-config>
    <net-info>
      <net-label>internal-control</net-label>
      <net-id>internal-control</net-id>
      <binding-type>normal</binding-type>
    </net-info>
    <net-info>
      <net-label>trustedv4mngt</net-label>
      <net-id>oam</net-id>
      <binding-type>normal</binding-type>
      <device-name-ipvlan>vlan100</device-name-ipvlan>
    </net-info>
    <net-info>
      <net-label>trustedsig</net-label>
      <net-id>tsig0</net-id>
      <binding-type>normal</binding-type>
      <device-name-ipvlan>vlan340</device-name-ipvlan>
    </net-info>
    <net-info>
      <net-label>trustedmed</net-label>
      <net-id>tmed0</net-id>
      <binding-type>normal</binding-type>
    </net-info>
    <net-info>
      <net-label>untrustedmed</net-label>
      <net-id>umed0</net-id>
      <binding-type>direct</binding-type>
      <device-pool-dpdk>a</device-pool-dpdk>
      <device-pool-dpdk>b</device-pool-dpdk>
      <vlan-tag>-1</vlan-tag>
    </net-info>
  </cloud-deployment-config>
</config>
`

func xmlCands(t *testing.T, doc string) []plugin.Candidate {
	t.Helper()
	c, err := parsers.XMLParser{}.Extract("f.xml", []byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// Somebody adds ONE network in the middle of the file. Comparing the two
// versions by path says they added six settings, left two parameters bound to
// nothing, and - silently - re-pointed eight more at a different network than
// their name says. Aligning the two versions says what they actually did.
func TestRealignSeesOneInsertedEntry(t *testing.T) {
	inserted := `    <net-info>
      <net-label>trustedv4mngt2</net-label>
      <net-id>oam</net-id>
      <binding-type>normal</binding-type>
      <device-name-ipvlan>vlan101</device-name-ipvlan>
    </net-info>
`
	at := strings.Index(netInfoXML, "    <net-info>\n      <net-label>trustedsig")
	edited := netInfoXML[:at] + inserted + netInfoXML[at:]

	r := Realign("f.xml", xmlCands(t, netInfoXML), xmlCands(t, edited))

	if len(r.Added) != 4 {
		t.Fatalf("Added = %d, want the 4 settings of the block that was typed in:\n%s", len(r.Added), names(r))
	}
	want := map[string]string{
		"net-label": "trustedv4mngt2", "net-id": "oam",
		"binding-type": "normal", "device-name-ipvlan": "vlan101",
	}
	for _, p := range r.Added {
		leaf := leafOf(p.Name)
		if v, ok := want[leaf]; !ok || v != p.Default {
			t.Errorf("added %s = %v, not one of the inserted block's settings", p.Name, p.Default)
		}
		// And at the path the block really occupies - the third entry - not
		// somewhere at the end of the file.
		if !strings.Contains(p.Bindings[0].Path, "net-info[3]/") {
			t.Errorf("added %s is at %s, want the inserted entry's own path", leaf, p.Bindings[0].Path)
		}
	}
	if len(r.Removed) != 0 {
		t.Errorf("Removed = %v, want nothing (an insert deletes nothing)", r.Removed)
	}
	// Everything from the insertion point down follows its entry one place.
	if len(r.Moved) == 0 {
		t.Fatal("nothing reported as moved, so the bindings below the insert would silently re-point")
	}
	for _, m := range r.Moved {
		if !SameEntry(m.From, m.To) {
			t.Errorf("move %s -> %s is not the same setting in a different place", m.From, m.To)
		}
	}
	moved := map[string]string{}
	for _, m := range r.Moved {
		moved[m.From] = m.To
	}
	for from, to := range map[string]string{
		"/config/cloud-deployment-config/net-info[3]/net-label": "/config/cloud-deployment-config/net-info[4]/net-label",
		"/config/cloud-deployment-config/net-info[5]/vlan-tag":  "/config/cloud-deployment-config/net-info[6]/vlan-tag",
	} {
		if moved[from] != to {
			t.Errorf("%s moved to %q, want %q", from, moved[from], to)
		}
	}
}

// Appending an entry at the end moves nothing: the answer must be the four (or
// however many) settings of the new block and not one re-point.
func TestRealignAppendMovesNothing(t *testing.T) {
	at := strings.Index(netInfoXML, "  </cloud-deployment-config>")
	edited := netInfoXML[:at] + `    <net-info>
      <net-label>extra</net-label>
      <net-id>ex0</net-id>
    </net-info>
` + netInfoXML[at:]

	r := Realign("f.xml", xmlCands(t, netInfoXML), xmlCands(t, edited))
	if len(r.Added) != 2 || len(r.Moved) != 0 || len(r.Removed) != 0 {
		t.Fatalf("added %d, moved %d, removed %d; want 2/0/0:\n%s",
			len(r.Added), len(r.Moved), len(r.Removed), names(r))
	}
}

// Changing one value is not an addition and not a removal. It is the same
// setting, still there, holding something else.
func TestRealignValueEditIsNeitherAddNorRemove(t *testing.T) {
	edited := strings.Replace(netInfoXML, "<net-id>tsig0</net-id>", "<net-id>tsig9</net-id>", 1)
	r := Realign("f.xml", xmlCands(t, netInfoXML), xmlCands(t, edited))
	if len(r.Added) != 0 || len(r.Removed) != 0 || len(r.Moved) != 0 {
		t.Fatalf("added %d, moved %d, removed %d; want nothing:\n%s",
			len(r.Added), len(r.Moved), len(r.Removed), names(r))
	}
}

// Deleting an entry is the mirror image: its settings are gone, and everything
// below it moves UP one place rather than being reported as new.
func TestRealignSeesADeletedEntry(t *testing.T) {
	start := strings.Index(netInfoXML, "    <net-info>\n      <net-label>trustedsig")
	end := strings.Index(netInfoXML[start:], "</net-info>\n") + start + len("</net-info>\n")
	edited := netInfoXML[:start] + netInfoXML[end:]

	r := Realign("f.xml", xmlCands(t, netInfoXML), xmlCands(t, edited))
	if len(r.Added) != 0 {
		t.Errorf("Added = %s, want nothing", names(r))
	}
	if len(r.Removed) != 4 {
		t.Errorf("Removed = %v, want the deleted entry's 4 settings", r.Removed)
	}
	if len(r.Moved) == 0 {
		t.Error("the entries below the deletion did not follow it up a place")
	}
}

// A JSON list entry inserted in the middle is the same problem in another
// format, and it only works because JSON candidates come out in document order.
func TestRealignJSONListInsert(t *testing.T) {
	before := `{"servers":[{"name":"a","port":1},{"name":"c","port":3}]}`
	after := `{"servers":[{"name":"a","port":1},{"name":"b","port":2},{"name":"c","port":3}]}`
	cands := func(s string) []plugin.Candidate {
		c, err := parsers.JSONParser{}.Extract("f.json", []byte(s))
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	r := Realign("f.json", cands(before), cands(after))
	if len(r.Added) != 1 || len(r.Removed) != 0 {
		t.Fatalf("added %d removed %d, want 1/0:\n%s", len(r.Added), len(r.Removed), names(r))
	}
	// name is the identity key, so the entry is addressed by it and only "port"
	// remains a tunable setting.
	if got := r.Added[0].Default; got != 2 {
		t.Errorf("added value = %v, want the inserted entry's port", got)
	}
}

func names(r Realignment) string {
	var b strings.Builder
	for _, p := range r.Added {
		b.WriteString("  + " + p.Bindings[0].Path + " = " + toStr(p.Default) + "\n")
	}
	for _, p := range r.Removed {
		b.WriteString("  - " + p + "\n")
	}
	for _, m := range r.Moved {
		b.WriteString("  ~ " + m.From + " -> " + m.To + "\n")
	}
	return b.String()
}

func toStr(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return "?"
}
