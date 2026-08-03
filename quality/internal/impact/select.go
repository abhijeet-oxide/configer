package impact

import (
	"fmt"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
	"github.com/abhijeet-oxide/configer/quality/internal/pathmatch"
	"github.com/abhijeet-oxide/configer/quality/internal/spec"
)

// Plan is the decision: what runs, what does not, and why. It is produced
// before anything executes and printed by `cq plan`, because a platform that
// silently skips work is a platform nobody trusts. Every skip carries a reason
// in plain words.
type Plan struct {
	Tier         model.Tier
	BaseRef      string
	Changes      []Change
	ChangedPaths []string
	Scopes       []string
	Full         bool

	Selected []model.Analyzer
	Skipped  []Skip
}

// Skip is one analyzer that will not run, and the sentence explaining it.
type Skip struct {
	ID     string
	Reason string
}

// Classify maps changed files onto the repository's declared scopes. A file
// that matches nothing lands in "other", which is treated as impacting
// everything: an unrecognized path is a reason to be careful, not a reason to
// skip work.
func Classify(paths []string, scopes map[string][]string) []string {
	hit := map[string]bool{}
	for _, p := range paths {
		matched := false
		for name, globs := range scopes {
			if pathmatch.MatchAny(globs, p) {
				hit[name] = true
				matched = true
			}
		}
		if !matched {
			hit["other"] = true
		}
	}
	out := make([]string, 0, len(hit))
	for s := range hit {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

// DocsOnly reports whether the change touches documentation and nothing else.
// It is called out explicitly because it is the single most common change shape
// in a healthy repository and the one where running the full suite is pure
// waste.
func DocsOnly(scopes []string) bool {
	if len(scopes) == 0 {
		return false
	}
	for _, s := range scopes {
		if s != "docs" {
			return false
		}
	}
	return true
}

// Selector decides which analyzers run.
type Selector struct {
	Cfg  *spec.Config
	Tier model.Tier
	// Full forces every analyzer at the tier to run regardless of the diff. The
	// default branch always runs full: incremental selection is an optimization
	// for feedback speed, never the record of whether the trunk is healthy.
	Full bool
	// Only, when set, restricts the run to these analyzer ids (plus what they
	// need). This is what an AI agent uses to re-run just the checks that
	// failed, instead of paying for the whole suite again.
	Only []string
}

// Select builds the plan.
func (s Selector) Select(analyzers []model.Analyzer, changes []Change) Plan {
	paths := AllPaths(changes)
	paths = pathmatch.Reject(s.Cfg.Ignore, paths)
	scopes := Classify(paths, s.Cfg.Scopes)

	p := Plan{
		Tier: s.Tier, Changes: changes, ChangedPaths: paths,
		Scopes: scopes, Full: s.Full,
	}

	only := map[string]bool{}
	for _, id := range s.Only {
		only[id] = true
	}
	docsOnly := !s.Full && DocsOnly(scopes)

	chosen := map[string]model.Analyzer{}
	for _, a := range analyzers {
		if !a.IsEnabled() {
			p.Skipped = append(p.Skipped, Skip{a.ID, "disabled in cq.yaml"})
			continue
		}
		if !a.RunsAt(s.Tier) {
			p.Skipped = append(p.Skipped, Skip{a.ID, fmt.Sprintf("not part of the %s tier", s.Tier)})
			continue
		}
		if len(only) > 0 {
			if !only[a.ID] {
				p.Skipped = append(p.Skipped, Skip{a.ID, "not requested by --only"})
				continue
			}
			// Naming an analyzer explicitly overrides the diff. This is the
			// agent's re-run path: after a fix, "run exactly the check that
			// failed" must run it, whether or not the edit happened to touch a
			// file that analyzer's triggers recognize.
			chosen[a.ID] = a
			continue
		}
		if reason, ok := s.wants(a, paths, scopes, docsOnly); !ok {
			p.Skipped = append(p.Skipped, Skip{a.ID, reason})
			continue
		}
		chosen[a.ID] = a
	}

	// An analyzer's prerequisites come along whether or not the diff selected
	// them: a bundle measurement without its build is not a cheaper answer, it
	// is no answer.
	index := map[string]model.Analyzer{}
	for _, a := range analyzers {
		index[a.ID] = a
	}
	var pull func(id string)
	pull = func(id string) {
		a, ok := index[id]
		if !ok || !a.IsEnabled() {
			return
		}
		if _, done := chosen[id]; done {
			return
		}
		chosen[id] = a
		for _, n := range a.Needs {
			pull(n)
		}
	}
	for id := range chosen {
		for _, n := range chosen[id].Needs {
			pull(n)
		}
	}
	// Anything pulled in as a prerequisite is no longer a skip.
	filtered := p.Skipped[:0]
	for _, sk := range p.Skipped {
		if _, isChosen := chosen[sk.ID]; !isChosen {
			filtered = append(filtered, sk)
		}
	}
	p.Skipped = filtered

	for _, a := range chosen {
		p.Selected = append(p.Selected, a)
	}
	sort.Slice(p.Selected, func(i, j int) bool {
		// Heaviest first: the long pole should never be the last thing started.
		if p.Selected[i].Cost.Weight() != p.Selected[j].Cost.Weight() {
			return p.Selected[i].Cost.Weight() > p.Selected[j].Cost.Weight()
		}
		return p.Selected[i].ID < p.Selected[j].ID
	})
	sort.Slice(p.Skipped, func(i, j int) bool { return p.Skipped[i].ID < p.Skipped[j].ID })
	return p
}

// wants applies the incremental rules to one analyzer, returning the sentence
// that explains a "no".
func (s Selector) wants(a model.Analyzer, paths, scopes []string, docsOnly bool) (string, bool) {
	if a.AlwaysRun {
		return "", true
	}
	if s.Full {
		return "", true
	}
	if len(paths) == 0 {
		return "nothing changed", false
	}
	if docsOnly {
		if containsScope(a.Scopes, "docs") {
			return "", true
		}
		return "only documentation changed", false
	}
	// An analyzer that declares neither a scope nor a path is repository-wide
	// by construction, so any non-documentation change selects it.
	if len(a.Scopes) == 0 && len(a.Paths) == 0 {
		return "", true
	}
	if len(a.Scopes) > 0 && intersects(a.Scopes, scopes) {
		return "", true
	}
	// "other" means a path the repository has not classified. Anything
	// unclassified selects every analyzer: silence on an unknown file is the
	// one failure mode of incremental selection that actually hurts.
	if containsScope(scopes, "other") {
		return "", true
	}
	if len(a.Paths) > 0 && pathmatch.MatchAnyOf(a.Paths, paths) {
		return "", true
	}
	switch {
	case len(a.Scopes) > 0:
		return fmt.Sprintf("no change under %s", strings.Join(a.Scopes, ", ")), false
	default:
		return "no changed file matches its triggers", false
	}
}

func intersects(a, b []string) bool {
	for _, x := range a {
		for _, y := range b {
			if x == y {
				return true
			}
		}
	}
	return false
}

func containsScope(list []string, want string) bool {
	for _, x := range list {
		if x == want {
			return true
		}
	}
	return false
}

// ChangedFilesFor returns the subset of the diff an analyzer should be pointed
// at, honouring its own path triggers. Handing a Go linter a list of TypeScript
// files is how per-file invocation usually goes wrong.
func (p Plan) ChangedFilesFor(a model.Analyzer) []string {
	live := make([]string, 0, len(p.Changes))
	for _, c := range p.Changes {
		if !c.Deleted() {
			live = append(live, c.Path)
		}
	}
	if len(a.Paths) == 0 {
		return live
	}
	return pathmatch.Filter(a.Paths, live)
}

// SelectedIDs lists the analyzer ids in the plan.
func (p Plan) SelectedIDs() []string {
	out := make([]string, 0, len(p.Selected))
	for _, a := range p.Selected {
		out = append(out, a.ID)
	}
	sort.Strings(out)
	return out
}

// SkippedIDs lists the skipped analyzer ids with their reasons attached, in the
// "id (reason)" form the report and the CLI both print.
func (p Plan) SkippedIDs() []string {
	out := make([]string, 0, len(p.Skipped))
	for _, s := range p.Skipped {
		out = append(out, fmt.Sprintf("%s (%s)", s.ID, s.Reason))
	}
	return out
}
