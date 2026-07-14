package pathedit

import (
	"reflect"
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// --- path parsing ------------------------------------------------------------

func TestParsePath(t *testing.T) {
	cases := []struct {
		in   string
		want []Seg
	}{
		{"$.a.b.c", []Seg{{Key: "a", Index: -1}, {Key: "b", Index: -1}, {Key: "c", Index: -1}}},
		{"a", []Seg{{Key: "a", Index: -1}}},
		{"servers[2]", []Seg{{Key: "servers", Index: 2}}},
		{"$.rules[name=ssh].port", []Seg{{Key: "rules", Index: -1, SelKey: "name", SelVal: "ssh"}, {Key: "port", Index: -1}}},
		{"rules[cidr=10.0.0.0/8].allow", []Seg{{Key: "rules", Index: -1, SelKey: "cidr", SelVal: "10.0.0.0/8"}, {Key: "allow", Index: -1}}},
		{"a[0][1]", []Seg{{Key: "a", Index: 0}, {Index: 1}}},
	}
	for _, c := range cases {
		got, err := ParsePath(c.in)
		if err != nil {
			t.Errorf("ParsePath(%q): %v", c.in, err)
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("ParsePath(%q) = %+v, want %+v", c.in, got, c.want)
		}
	}
	for _, bad := range []string{"", "$.a[x]", "a[-1]", "a[1"} {
		if _, err := ParsePath(bad); err == nil {
			t.Errorf("ParsePath(%q): want error", bad)
		}
	}
}

// --- YAML ---------------------------------------------------------------------

func TestYAMLSetGolden(t *testing.T) {
	base := `# Platform values. Structure = truth.
service:
  ip: 10.0.0.1 # the service ip
  port: 8080
other: keep-me
`
	got, err := Set([]byte(base), "yaml", "$.service.ip", model.TypeIPv4, "10.9.9.9")
	if err != nil {
		t.Fatal(err)
	}
	want := `# Platform values. Structure = truth.
service:
  ip: 10.9.9.9 # the service ip
  port: 8080
other: keep-me
`
	if got != want {
		t.Errorf("surgical YAML edit drifted:\n--- got ---\n%s--- want ---\n%s", got, want)
	}
}

func TestYAMLSetSequenceIndex(t *testing.T) {
	base := "servers:\n  - 1.1.1.1\n  - 2.2.2.2\n"
	got, err := Set([]byte(base), "yaml", "$.servers[1]", model.TypeIPv4, "9.9.9.9")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "- 9.9.9.9") || !strings.Contains(got, "- 1.1.1.1") {
		t.Errorf("index write wrong:\n%s", got)
	}
	// append at len
	got, err = Set([]byte(base), "yaml", "$.servers[2]", model.TypeIPv4, "3.3.3.3")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "- 3.3.3.3") {
		t.Errorf("append write wrong:\n%s", got)
	}
	// out of range
	if _, err := Set([]byte(base), "yaml", "$.servers[5]", model.TypeIPv4, "x"); err == nil {
		t.Error("out-of-range index: want error")
	}
}

func TestYAMLSetSelector(t *testing.T) {
	base := `rules:
  - name: ssh
    port: 22
  - name: http
    port: 80
`
	got, err := Set([]byte(base), "yaml", "$.rules[name=http].port", model.TypeInteger, 8080)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "port: 8080") || !strings.Contains(got, "port: 22") {
		t.Errorf("selector write wrong:\n%s", got)
	}
}

func TestYAMLRemovePrunesEmptyParents(t *testing.T) {
	base := "service:\n  ip: 10.0.0.1\nkeep: yes\n"
	got, err := Remove([]byte(base), "yaml", "$.service.ip", model.TypeIPv4)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "ip:") || strings.Contains(got, "service:") {
		t.Errorf("remove did not prune:\n%s", got)
	}
	if !strings.Contains(got, "keep: yes") {
		t.Errorf("unrelated key lost:\n%s", got)
	}
}

func TestYAMLRemoveSequenceElement(t *testing.T) {
	base := "servers:\n  - 1.1.1.1\n  - 2.2.2.2\n"
	got, err := Remove([]byte(base), "yaml", "$.servers[0]", model.TypeIPv4)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "1.1.1.1") || !strings.Contains(got, "2.2.2.2") {
		t.Errorf("sequence removal wrong:\n%s", got)
	}
	// removing the last element prunes the now-empty key
	got, err = Remove([]byte("servers:\n  - 1.1.1.1\nkeep: 1\n"), "yaml", "$.servers[0]", model.TypeIPv4)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "servers:") {
		t.Errorf("empty sequence not pruned:\n%s", got)
	}
}

func TestYAMLSetNewFile(t *testing.T) {
	got, err := Set(nil, "yaml", "$.foo.bar", model.TypeInteger, 42)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "bar: 42") {
		t.Errorf("new document wrong:\n%s", got)
	}
}

func TestYAMLSetList(t *testing.T) {
	got, err := Set([]byte("servers: [1.1.1.1]\nkeep: 1\n"), "yaml", "$.servers", model.TypeList, []any{"a", "b"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"- a", "- b", "keep: 1"} {
		if !strings.Contains(got, want) {
			t.Errorf("list write missing %q:\n%s", want, got)
		}
	}
}

func TestYAMLGet(t *testing.T) {
	base := "service:\n  port: 8080\nservers:\n  - a\n  - b\nrules:\n  - name: ssh\n    port: 22\n"
	v, ok, err := Get([]byte(base), "yaml", "$.service.port")
	if err != nil || !ok || v != 8080 {
		t.Errorf("Get scalar = %v %v %v", v, ok, err)
	}
	v, ok, _ = Get([]byte(base), "yaml", "$.servers[1]")
	if !ok || v != "b" {
		t.Errorf("Get index = %v %v", v, ok)
	}
	v, ok, _ = Get([]byte(base), "yaml", "$.rules[name=ssh].port")
	if !ok || v != 22 {
		t.Errorf("Get selector = %v %v", v, ok)
	}
	_, ok, _ = Get([]byte(base), "yaml", "$.missing.path")
	if ok {
		t.Error("Get missing: want ok=false")
	}
	v, ok, _ = Get([]byte(base), "yaml", "$.servers")
	if !ok || !reflect.DeepEqual(v, []any{"a", "b"}) {
		t.Errorf("Get list = %#v %v", v, ok)
	}
}

// --- JSON ---------------------------------------------------------------------

func TestJSONSetPreservesKeyOrder(t *testing.T) {
	base := `{
  "zebra": 1,
  "service": {
    "port": 8080,
    "alpha": true
  },
  "apple": "x"
}
`
	got, err := Set([]byte(base), "json", "$.service.port", model.TypeInteger, 9090)
	if err != nil {
		t.Fatal(err)
	}
	want := `{
  "zebra": 1,
  "service": {
    "port": 9090,
    "alpha": true
  },
  "apple": "x"
}
`
	if got != want {
		t.Errorf("JSON edit reordered or reformatted:\n--- got ---\n%s--- want ---\n%s", got, want)
	}
}

func TestJSONRemoveAndTypes(t *testing.T) {
	base := `{"a": {"b": 1}, "s": "text", "f": 1.5, "t": true, "n": null, "list": [1, 2]}`
	got, err := Remove([]byte(base), "json", "$.a.b", model.TypeInteger)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"s": "text"`, `"f": 1.5`, `"t": true`, `"n": null`} {
		if !strings.Contains(got, want) {
			t.Errorf("JSON types mangled, missing %s:\n%s", want, got)
		}
	}
	if strings.Contains(got, `"a"`) {
		t.Errorf("empty parent not pruned:\n%s", got)
	}
}

// --- XML ----------------------------------------------------------------------

func TestXMLSetAndGet(t *testing.T) {
	base := "<network>\n  <service>\n    <ip>10.0.0.1</ip>\n  </service>\n  <tls minVersion=\"1.2\"/>\n</network>\n"
	got, err := Set([]byte(base), "xml", "/network/service/ip", model.TypeIPv4, "10.9.9.9")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "10.9.9.9") {
		t.Errorf("xml element text not set:\n%s", got)
	}

	got, err = Set([]byte(base), "xml", "/network/tls/@minVersion", model.TypeString, "1.3")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, `minVersion="1.3"`) {
		t.Errorf("xml attribute not set:\n%s", got)
	}

	v, ok, err := Get([]byte(base), "xml", "/network/tls/@minVersion")
	if err != nil || !ok || v != "1.2" {
		t.Errorf("xml attr Get = %v %v %v", v, ok, err)
	}
}

func TestXMLListRoundTrip(t *testing.T) {
	base := "<network>\n  <syslog>\n    <collector>10.0.9.1</collector>\n    <collector>10.0.9.2</collector>\n  </syslog>\n</network>\n"
	v, ok, _ := Get([]byte(base), "xml", "/network/syslog/collector")
	if !ok || !reflect.DeepEqual(v, []any{"10.0.9.1", "10.0.9.2"}) {
		t.Errorf("xml list Get = %#v %v", v, ok)
	}

	got, err := Set([]byte(base), "xml", "/network/syslog/collector", model.TypeList, []any{"a", "b", "c"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(got, "<collector>") != 3 {
		t.Errorf("xml list cardinality wrong:\n%s", got)
	}

	got, err = Remove([]byte(base), "xml", "/network/syslog/collector", model.TypeList)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "collector") || strings.Contains(got, "<syslog") {
		t.Errorf("xml list removal left a husk:\n%s", got)
	}
}
