// Package region reads an instance's REGION out of its own name.
//
// In a large estate a name is never arbitrary: it carries a site code, a cloud
// region, or a state, and everybody who works there reads it that way already.
// Onboarding a hundred instances and leaving a column of dashes for somebody to
// fill in by hand is asking a person to retype what the name has been saying
// all along.
//
// The rules are DATA, not code (regions.yaml, embedded), and a repository
// overrides them with its own .configer/regions.yaml. That is what keeps this
// from becoming a list of one company's site codes compiled into the product:
// adding a site is a line of YAML in the repository that has the site.
//
// A rule matches CASE-INSENSITIVELY. By default its pattern must stand alone in
// the name, bounded by anything that is not a letter or digit or by either end
// of it: "edge-tx-02" is Texas and "canyon-01" is not California. A site code
// runs straight into the rest of the identifier, so those rules opt in with
// "where: prefix" and match from the front.
//
// Detection only ever FILLS IN a region nobody has set. It never overwrites
// one, because a guess read out of a name must not overrule somebody who knew.
package region

import (
	_ "embed"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

//go:embed regions.yaml
var builtinRules []byte

// RulesFile is the shape of both the built-in rules and a repository's own.
type RulesFile struct {
	Rules []Rule `yaml:"rules" json:"rules"`
}

// Rule maps a fragment of an instance name to the region it denotes.
type Rule struct {
	Match string `yaml:"match" json:"match"`
	// Where says how the pattern is allowed to sit in the name:
	//
	//   token  (default) - it must stand alone, bounded by anything that is not
	//                      a letter or digit, or by either end of the name.
	//   prefix           - it starts the name and may run straight into the rest
	//                      of it, which is how a site code is written.
	//
	// The two are not interchangeable and the difference is load-bearing. A
	// short pattern matched anywhere reads half an estate wrong: "ca" as a
	// prefix makes "canyon-01" California.
	Where  string `yaml:"where,omitempty" json:"where,omitempty"`
	Region string `yaml:"region" json:"region"`
	// Lat and Lon place the region on a map. They are optional: a rule that
	// names a place without locating it still fills the field in, it just does
	// not get a pin - which is the honest outcome for a name nobody has said
	// where to draw.
	Lat *float64 `yaml:"lat,omitempty" json:"lat,omitempty"`
	Lon *float64 `yaml:"lon,omitempty" json:"lon,omitempty"`
}

// Place is one region a map can draw: a name and where on earth it is.
type Place struct {
	Region string  `json:"region"`
	Lat    float64 `json:"lat"`
	Lon    float64 `json:"lon"`
}

// Places returns every region the rules can locate, one entry per region name.
// The first rule to name a region places it, so a repository's own coordinates
// win over the shipped ones exactly as its names do.
func (r Rules) Places() []Place {
	seen := map[string]bool{}
	out := []Place{}
	for _, rule := range r.rules {
		if rule.Lat == nil || rule.Lon == nil || seen[rule.Region] {
			continue
		}
		seen[rule.Region] = true
		out = append(out, Place{Region: rule.Region, Lat: *rule.Lat, Lon: *rule.Lon})
	}
	return out
}

// WherePrefix is the opt-in for a pattern that runs into the rest of the name.
const WherePrefix = "prefix"

// RepoRulesPath is where a repository states its own rules.
const RepoRulesPath = ".configer/regions.yaml"

// Rules is an ordered rule set, longest pattern first.
type Rules struct {
	rules []Rule
}

// Load returns the rules in force for one repository: its own first, then the
// built-in defaults. A repository with no rules file gets the defaults, and a
// rules file that will not parse is passed over rather than failing the scan -
// onboarding must not stop because a hint file has a typo in it.
func Load(root string) Rules {
	var own RulesFile
	if raw, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(RepoRulesPath))); err == nil {
		_ = yaml.Unmarshal(raw, &own)
	}
	var builtin RulesFile
	_ = yaml.Unmarshal(builtinRules, &builtin)

	all := make([]Rule, 0, len(own.Rules)+len(builtin.Rules))
	for _, r := range append(own.Rules, builtin.Rules...) {
		if r.Match != "" && r.Region != "" {
			r.Match = strings.ToLower(strings.TrimSpace(r.Match))
			r.Where = strings.ToLower(strings.TrimSpace(r.Where))
			all = append(all, r)
		}
	}
	// Longest pattern first, so a specific code is never shadowed by a shorter
	// one that happens to prefix it. The sort is STABLE, which is what leaves a
	// repository's own rule ahead of a built-in of the same length.
	sort.SliceStable(all, func(i, j int) bool { return len(all[i].Match) > len(all[j].Match) })
	return Rules{rules: all}
}

// Detect returns the region an instance name denotes, or "" when none of the
// rules recognizes it.
//
// A region invented out of a coincidence is worse than an empty field somebody
// fills in themselves, so how a pattern may sit in the name is part of the rule
// rather than a guess made here.
func (r Rules) Detect(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	if name == "" {
		return ""
	}
	for _, rule := range r.rules {
		if matches(name, rule.Match, rule.Where == WherePrefix) {
			return rule.Region
		}
	}
	return ""
}

func matches(name, pattern string, prefix bool) bool {
	if pattern == "" || len(pattern) > len(name) {
		return false
	}
	if prefix {
		return strings.HasPrefix(name, pattern)
	}
	for i := 0; ; {
		j := strings.Index(name[i:], pattern)
		if j < 0 {
			return false
		}
		start := i + j
		end := start + len(pattern)
		startOK := start == 0 || !alnum(name[start-1])
		endOK := end == len(name) || !alnum(name[end])
		if startOK && endOK {
			return true
		}
		i = start + 1
	}
}

func alnum(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}
