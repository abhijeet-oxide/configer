package parsers

import "github.com/abhijeet-oxide/configer/backend/internal/plugin"

// Register adds all built-in ingest parsers to the registry.
func Register(reg *plugin.Registry) {
	reg.RegisterParser(YAMLParser{})
	reg.RegisterParser(JSONParser{})
	reg.RegisterParser(XMLParser{})
}
