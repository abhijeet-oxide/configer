// Package transformers holds the release-candidate transformers: how a release
// Software Gateway onboarded becomes a change in its configuration repository.
//
// None ships. Until one is registered here, every release candidate waits in
// ArtiAuto with the reason on Software Gateway's release page.
package transformers

import "github.com/abhijeet-oxide/configer/internal/plugin"

// Register adds every built-in transformer.
func Register(reg *plugin.Registry) {
	_ = reg
}
