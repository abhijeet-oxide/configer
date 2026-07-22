package sources

import "github.com/abhijeet-oxide/configer/backend/internal/plugin"

// Register wires the built-in source providers into a plugin registry. Called
// at server startup next to parsers.Register. Adding a new source kind is one
// line here plus its provider file.
func Register(reg *plugin.Registry) {
	reg.RegisterSource(gitSource{reg: reg})
	reg.RegisterSource(newVaultSource())
}
