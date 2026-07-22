package parsers

import "testing"

func TestYAMLExtract(t *testing.T) {
	content := []byte("network:\n  service:\n    ip: 10.0.0.1\n    port: 8080\n  enabled: true\n")
	got, err := YAMLParser{}.Extract("values.yaml", content)
	if err != nil {
		t.Fatal(err)
	}
	byPath := map[string]any{}
	for _, c := range got {
		byPath[c.Path] = c.Value
	}
	if byPath["$.network.service.ip"] != "10.0.0.1" {
		t.Errorf("ip = %v", byPath["$.network.service.ip"])
	}
	if _, ok := byPath["$.network.service.port"]; !ok {
		t.Error("missing port candidate")
	}
	if byPath["$.network.enabled"] != true {
		t.Errorf("enabled = %v", byPath["$.network.enabled"])
	}
}

// A file bundling several YAML documents ("---") must yield candidates from
// EVERY document, each tagged with its 0-based document selector so identically
// named fields in sibling documents stay distinct.
func TestYAMLExtractMultiDoc(t *testing.T) {
	content := []byte("kind: ConfigMap\ndata:\n  level: info\n---\nkind: Service\nspec:\n  port: 8080\n")
	got, err := YAMLParser{}.Extract("bundle.yaml", content)
	if err != nil {
		t.Fatal(err)
	}
	byPath := map[string]any{}
	name := map[string]string{}
	for _, c := range got {
		byPath[c.Path] = c.Value
		name[c.Path] = c.Name
	}
	if byPath["[0]$.data.level"] != "info" {
		t.Errorf("doc0 level missing: %v", byPath)
	}
	if _, ok := byPath["[1]$.spec.port"]; !ok {
		t.Errorf("doc1 port missing (multi-doc dropped?): %v", byPath)
	}
	// The display name drops the document selector.
	if name["[1]$.spec.port"] != "spec.port" {
		t.Errorf("name = %q, want spec.port", name["[1]$.spec.port"])
	}
}

func TestXMLExtract(t *testing.T) {
	content := []byte(`<network><tls minVersion="1.2"><cipher>AES</cipher></tls></network>`)
	got, err := XMLParser{}.Extract("network.xml", content)
	if err != nil {
		t.Fatal(err)
	}
	byPath := map[string]any{}
	for _, c := range got {
		byPath[c.Path] = c.Value
	}
	if byPath["/network/tls/@minVersion"] != "1.2" {
		t.Errorf("minVersion = %v (paths: %v)", byPath["/network/tls/@minVersion"], byPath)
	}
	if byPath["/network/tls/cipher"] != "AES" {
		t.Errorf("cipher = %v", byPath["/network/tls/cipher"])
	}
}

func TestInferType(t *testing.T) {
	if inferType("10.0.0.1") != "ipv4" {
		t.Error("want ipv4")
	}
	if inferType("10.0.0.0/24") != "cidr" {
		t.Error("want cidr")
	}
	if inferType(true) != "boolean" {
		t.Error("want boolean")
	}
}
