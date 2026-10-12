package region

import (
	"os"
	"path/filepath"
	"testing"
)

func TestANameThatSaysWhereItRunsIsRead(t *testing.T) {
	r := Load(t.TempDir())

	for name, want := range map[string]string{
		// A site code runs into the rest of the identifier.
		"wnv0042a1b": "Warrenville",
		"WNV0042A1B": "Warrenville", // case is spelling, not meaning
		"ksc-edge-2": "Kansas City",
		"sho7a9":     "Sherman Oaks",
		// Everything else has to stand alone.
		"prod-us-east-1": "N. Virginia (us-east-1)",
		"app-eastus2":    "East US 2 (eastus2)",
		"edge-tx-02":     "Texas",
		"tx-edge-02":     "Texas",
	} {
		if got := r.Detect(name); got != want {
			t.Errorf("Detect(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestAGuessIsNotMadeOutOfACoincidence(t *testing.T) {
	r := Load(t.TempDir())

	// Two letters buried inside a word say nothing. A region invented out of a
	// coincidence is worse than an empty field somebody fills in themselves.
	for _, name := range []string{"canyon-01", "manatee", "", "cluster-7"} {
		if got := r.Detect(name); got != "" {
			t.Errorf("Detect(%q) = %q, want no answer", name, got)
		}
	}
}

func TestTheLongestPatternWins(t *testing.T) {
	r := Load(t.TempDir())
	// "us-east-1" and "us-east-2" both begin with a shorter rule's text; the
	// specific one has to win whatever order the rules were written in.
	if got := r.Detect("us-east-2-a"); got != "Ohio (us-east-2)" {
		t.Errorf("Detect = %q, want the us-east-2 rule", got)
	}
}

func TestARepositorySpellsItsOwnSites(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".configer"), 0o755); err != nil {
		t.Fatal(err)
	}
	rules := "rules:\n" +
		"  - { match: wnv, where: prefix, region: \"Site 12\" }\n" +
		"  - { match: hbk, where: prefix, region: \"Hollybrook\" }\n"
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(RepoRulesPath)), []byte(rules), 0o600); err != nil {
		t.Fatal(err)
	}
	r := Load(root)

	// The repository's own rule beats a built-in of the same length: it knows
	// its estate and the shipped defaults are only a starting point.
	if got := r.Detect("wnv0042a1b"); got != "Site 12" {
		t.Errorf("Detect = %q, want the repository's own rule", got)
	}
	if got := r.Detect("hbk-01"); got != "Hollybrook" {
		t.Errorf("Detect = %q, want Hollybrook", got)
	}
	// The defaults are still there underneath.
	if got := r.Detect("prod-us-west-2"); got != "Oregon (us-west-2)" {
		t.Errorf("Detect = %q, want the built-in rule", got)
	}
}

func TestAnUnreadableRulesFileIsPassedOverNotFatal(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".configer"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(RepoRulesPath)), []byte("rules: [[[["), 0o600); err != nil {
		t.Fatal(err)
	}
	// A typo in a hint file must not stop a scan; the defaults still answer.
	if got := Load(root).Detect("wnv0042a1b"); got != "Warrenville" {
		t.Errorf("Detect = %q, want the built-in rule", got)
	}
}
