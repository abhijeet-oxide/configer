package workspace

import "testing"

// TestNameFromURL covers URL, Unix path, and Windows path derivation — the
// last of which previously returned the whole path after the drive letter.
func TestNameFromURL(t *testing.T) {
	cases := map[string]string{
		`https://github.com/acme/network-config.git`:                  "network-config",
		`git@github.com:acme/network-config.git`:                      "network-config",
		`/srv/configs/network-platform`:                               "network-platform",
		`/srv/configs/network-platform/`:                              "network-platform",
		`C:\Users\ap999e\Workplace\DeployUsingFlux\apm0014228-deploy`: "apm0014228-deploy",
		`C:\Users\ap999e\Workplace\DeployUsingFlux\`:                  "DeployUsingFlux",
	}
	for in, want := range cases {
		if got := NameFromURL(in); got != want {
			t.Errorf("NameFromURL(%q) = %q, want %q", in, got, want)
		}
	}
}
