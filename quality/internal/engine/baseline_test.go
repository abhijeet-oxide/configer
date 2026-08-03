package engine

import "testing"

// The read path and the write path must derive the baseline's name identically.
// They once did not: a run with no --base saved under the branch name and looked
// up under "default", so every regression budget reported "skip" forever and the
// pipeline stayed green with its gates quietly switched off.
//
// That failure is silent by construction, which is exactly why it gets a test.
func TestBaselineRefIsTheSameOnBothPaths(t *testing.T) {
	cases := []struct {
		name, baseRef, branch, want string
	}{
		{"a pull request against main", "origin/main", "feature/x", "origin/main"},
		{"a local run with no base", "", "feature/x", "feature/x"},
		{"a detached head with no base", "", "", "default"},
		{"the base always wins over the branch", "origin/release-2", "main", "origin/release-2"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := BaselineRef(c.baseRef, c.branch); got != c.want {
				t.Errorf("BaselineRef(%q, %q) = %q, want %q", c.baseRef, c.branch, got, c.want)
			}
		})
	}
}

// Every analyzer manifest's declared output format must have a normalizer, or
// the analyzer fails at runtime with a message about an unknown format rather
// than at load with one about a typo. The catalog test asserts this for the
// shipped manifests; this asserts the lookup the engine itself uses.
func TestNormalizerLookup(t *testing.T) {
	if !normalizerFor("sarif") {
		t.Error("sarif must be a known format: eight shipped analyzers depend on it")
	}
	if normalizerFor("not-a-real-format") {
		t.Error("an unknown format must not resolve")
	}
}
