package parsers

import (
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/beevik/etree"
)

// XMLParser extracts parameters from XML documents, emitting an XPath for each
// leaf element and attribute.
type XMLParser struct{}

func (XMLParser) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID:          "builtin.xml",
		Name:        "XML",
		Version:     "1.0.0",
		Kind:        plugin.KindIngestParser,
		Description: "Extracts parameters from XML files, one candidate per leaf element/attribute.",
	}
}

func (XMLParser) Detect(path string, _ []byte) bool {
	return strings.HasSuffix(strings.ToLower(path), ".xml")
}

func (XMLParser) Extract(file string, content []byte) ([]plugin.Candidate, error) {
	doc := etree.NewDocument()
	if err := doc.ReadFromBytes(content); err != nil {
		return nil, err
	}
	var out []plugin.Candidate
	if root := doc.Root(); root != nil {
		walkXML(root, "/"+root.Tag, file, &out)
	}
	return out, nil
}

func walkXML(el *etree.Element, path, file string, out *[]plugin.Candidate) {
	// attributes are leaf parameters: /root/el/@attr. Namespace declarations
	// (xmlns / xmlns:*) are document structure, never tunable config, so skip
	// them - etree stores them as attributes with Space=="xmlns".
	for _, a := range el.Attr {
		if a.Space == "xmlns" || a.Key == "xmlns" {
			continue
		}
		p := path + "/@" + a.Key
		*out = append(*out, plugin.Candidate{
			Name:   xmlName(p),
			Path:   p,
			Type:   inferType(a.Value),
			Value:  a.Value,
			File:   file,
			Format: "xml",
		})
	}

	children := el.ChildElements()
	if len(children) == 0 {
		// leaf element with text content
		text := strings.TrimSpace(el.Text())
		if text != "" {
			*out = append(*out, plugin.Candidate{
				Name:   xmlName(path),
				Path:   path,
				Type:   inferType(text),
				Value:  text,
				File:   file,
				Format: "xml",
			})
		}
		return
	}
	// track repeated tags to add positional predicates
	counts := map[string]int{}
	for _, c := range children {
		counts[c.Tag]++
	}
	seen := map[string]int{}
	for _, c := range children {
		cp := path + "/" + c.Tag
		if counts[c.Tag] > 1 {
			seen[c.Tag]++
			cp = path + "/" + c.Tag + "[" + itoa(seen[c.Tag]) + "]"
		}
		walkXML(c, cp, file, out)
	}
}

func xmlName(path string) string {
	s := strings.TrimPrefix(path, "/")
	s = strings.ReplaceAll(s, "/@", ".")
	s = strings.ReplaceAll(s, "/", ".")
	return s
}

func itoa(i int) string {
	const digits = "0123456789"
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{digits[i%10]}, b...)
		i /= 10
	}
	return string(b)
}
