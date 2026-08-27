package yangvalidate

// The native engine walks a candidate document in lockstep with the model and
// reports what the two disagree about. It is deliberately NOT a complete YANG
// implementation - see yanglint.go for that - and it is deliberately always
// available, because the alternative on a developer's Windows machine and in
// every CI container that has not installed libyang is no document validation
// at all.
//
// It checks the things that only have an answer once the whole file exists:
//
//   - a mandatory leaf that was left out
//   - a list entry missing its key, or two entries colliding on one
//   - a "unique" statement two entries both satisfy
//   - a leafref pointing at a value that is not there
//   - too few or too many entries in a repeated node
//   - two branches of one choice both filled in
//   - a "must" or "when" condition, within the expression subset xpath.go reads
//   - and every leaf's own type and restrictions, because a file edited by hand
//     never went through the cell write path that checks them
//
// What it does NOT do is invent an answer. An expression it cannot read
// produces no finding at all rather than a guessed one, and the report says how
// many such conditions were passed over.

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/validate"
	"github.com/abhijeet-oxide/configer/backend/internal/yangschema"
)

// Native is the built-in document validator.
type Native struct{}

func (n *Native) Name() string { return "native" }

// Available is always true: this engine is the product itself, and a tier that
// disappears on the machines that most need it is not a tier.
func (n *Native) Available() (bool, string) { return true, "" }

func (n *Native) Validate(ctx context.Context, req Request) (Report, error) {
	rep := Report{Available: true, Documents: len(req.Documents)}
	if req.Set == nil || req.Set.Empty() {
		rep.Available = false
		rep.Reason = "this repository ships no YANG models, so there is nothing to validate against"
		return rep, nil
	}
	for i, doc := range req.Documents {
		if err := ctx.Err(); err != nil {
			return rep, err
		}
		if req.Progress != nil {
			req.Progress(Progress{Done: i, Total: len(req.Documents), File: doc.File, Findings: len(rep.Findings)})
		}
		root, err := Load(doc.File, doc.Format, doc.Content)
		if err != nil {
			// A file that does not parse is a syntax problem, and the editor
			// has already had its say about those. Reporting it here as a model
			// failure would name the wrong culprit.
			rep.Skipped = append(rep.Skipped, doc.File+": "+err.Error())
			continue
		}
		v := &walker{req: req, doc: doc, root: root, rep: &rep}
		v.walk(root, req.Set.Roots, nil)
	}
	if req.Progress != nil {
		req.Progress(Progress{Done: len(req.Documents), Total: len(req.Documents), Findings: len(rep.Findings)})
	}
	sortFindings(rep.Findings)
	return rep, nil
}

// walker carries the state one document's walk needs.
type walker struct {
	req  Request
	doc  Document
	root *Node
	rep  *Report
}

// walk descends one level: every document child is matched to a schema node of
// the same name, and the pair is checked together.
//
// A document child NO schema node claims is counted and passed over. It is
// routinely legitimate - a repository's file holds a Kubernetes envelope, a
// Helm value, a comment block the model has never heard of - and refusing it
// would make the tier unusable on every real repository.
func (w *walker) walk(docNode *Node, schemaNodes []*yangschema.Node, ancestry []*Node) {
	if len(ancestry) > maxDepth {
		return
	}
	byName := map[string]*yangschema.Node{}
	for _, s := range schemaNodes {
		if _, taken := byName[strings.ToLower(s.Name)]; !taken {
			byName[strings.ToLower(s.Name)] = s
		}
	}
	present := map[string]*Node{}
	for _, c := range docNode.Children {
		present[strings.ToLower(c.Name)] = c
	}

	for _, child := range docNode.Children {
		s := byName[strings.ToLower(child.Name)]
		if s == nil {
			// The model may still describe this subtree further down - a file
			// that starts at a wrapper the model does not name is the norm, not
			// the exception. So an unmatched node is descended INTO against the
			// same schema level rather than abandoned.
			if len(child.Children) > 0 || len(child.Entries) > 0 {
				w.walk(child, schemaNodes, append(ancestry, docNode))
				continue
			}
			w.rep.Unmatched++
			continue
		}
		w.check(child, s, append(ancestry, docNode))
	}

	// What is ABSENT is only knowable here, with the whole level in hand.
	w.checkMissing(docNode, schemaNodes, present, ancestry)
	w.checkChoices(docNode, schemaNodes, present)
}

// check validates one matched (document node, schema node) pair.
func (w *walker) check(doc *Node, s *yangschema.Node, ancestry []*Node) {
	if s.FeatureOff {
		w.add(doc, s, featureNote(s))
	}
	if s.Status == "obsolete" {
		w.add(doc, s, statusNote(s))
	}

	switch {
	case doc.Repeated || len(doc.Entries) > 0:
		w.checkRepeated(doc, s, ancestry)
	case doc.Leaf():
		w.checkLeaf(doc, s, ancestry)
	default:
		w.evalConditions(doc, s, ancestry)
		w.walk(doc, s.Children, ancestry)
	}
}

// checkRepeated validates a list or leaf-list: how many entries there are,
// whether each carries its key, whether the keys and unique tuples collide,
// and then each entry in its own right.
func (w *walker) checkRepeated(doc *Node, s *yangschema.Node, ancestry []*Node) {
	n := len(doc.Entries)
	if (s.MinElements != nil && n < *s.MinElements) || (s.MaxElements != nil && n > *s.MaxElements) {
		w.add(doc, s, countNote(s, n, s.MinElements, s.MaxElements))
	}

	// A list KEY identifies an entry. Missing, an entry cannot be addressed;
	// repeated, two entries claim one identity and whichever is applied last
	// silently wins.
	if len(s.Keys) > 0 {
		seen := map[string]int{}
		for i, entry := range doc.Entries {
			parts := make([]string, 0, len(s.Keys))
			missing := false
			for _, k := range s.Keys {
				kv := entry.Child(k)
				if kv == nil || !kv.Leaf() || isEmpty(kv.Scalar) {
					w.add(entry, s, keyMissingNote(s, i+1, k))
					missing = true
					break
				}
				parts = append(parts, fmt.Sprintf("%v", kv.Scalar))
			}
			if missing {
				continue
			}
			id := strings.Join(parts, "\x00")
			if first, clash := seen[id]; clash {
				w.add(entry, s, keyClashNote(s, first+1, i+1, s.Keys, parts))
				continue
			}
			seen[id] = i
		}
	}

	for _, u := range s.Uniques {
		w.checkUnique(doc, s, u)
	}
	for _, entry := range doc.Entries {
		if entry.Leaf() {
			w.checkLeaf(entry, s, ancestry)
			continue
		}
		w.evalConditions(entry, s, ancestry)
		w.walk(entry, s.Children, ancestry)
	}
}

// checkUnique enforces one "unique" statement: the named leaves, taken
// TOGETHER, must not repeat across entries. An entry missing any of them is
// exempt - RFC 7950 says a unique constraint only applies where every named
// leaf exists.
func (w *walker) checkUnique(doc *Node, s *yangschema.Node, leaves []string) {
	seen := map[string]int{}
	for i, entry := range doc.Entries {
		parts := make([]string, 0, len(leaves))
		complete := true
		for _, route := range leaves {
			v := resolveWithin(entry, route)
			if v == nil || !v.Leaf() || isEmpty(v.Scalar) {
				complete = false
				break
			}
			parts = append(parts, fmt.Sprintf("%v", v.Scalar))
		}
		if !complete {
			continue
		}
		id := strings.Join(parts, "\x00")
		if first, clash := seen[id]; clash {
			w.add(entry, s, uniqueNote(s, first+1, i+1, leaves, parts))
			continue
		}
		seen[id] = i
	}
}

// checkLeaf validates one value against everything its schema node says, and
// then the conditions attached to it.
func (w *walker) checkLeaf(doc *Node, s *yangschema.Node, ancestry []*Node) {
	w.rep.Values++

	// A file edited by hand never went through the cell write path, so this is
	// the first time anything has held the value against its own type. The
	// rules come from the same extractor the editor uses, which is what makes
	// the two tiers agree instead of contradicting each other.
	var p model.Parameter
	yangschema.Apply(&p, s)
	if p.Validation.ReadOnly {
		w.add(doc, s, readOnlyNote(s))
	}
	if !isEmpty(doc.Scalar) {
		written := fmt.Sprintf("%v", doc.Scalar)
		coerced, err := validate.CoerceValue(p, doc.Scalar)
		if err != nil {
			w.add(doc, s, typeNote(s, err.Error(), written))
		} else if r := validate.Value(p, coerced); !r.Valid {
			w.add(doc, s, typeNote(s, r.Message, written))
		}
	}

	if s.Type != nil && s.Type.LeafrefPath != "" && !isEmpty(doc.Scalar) {
		w.checkLeafref(doc, s, ancestry)
	}
	w.evalConditions(doc, s, ancestry)
}

// checkLeafref verifies the value names something that actually exists.
//
// "require-instance false" turns the reference into a hint rather than a rule,
// and is honoured: refusing a forward reference the model explicitly allowed
// would block a legitimate two-step change.
func (w *walker) checkLeafref(doc *Node, s *yangschema.Node, ancestry []*Node) {
	if s.Type.RequireInstance != nil && !*s.Type.RequireInstance {
		return
	}
	targets, resolvable := leafrefValues(w.root, ancestry, doc, s.Type.LeafrefPath)
	if !resolvable || len(targets) == 0 {
		// Either the route left the part of the tree this file holds, or it
		// resolved to nothing at all. A datastore has one tree; a repository has
		// files, and a target list that is empty HERE lives in another one far
		// more often than it is missing. Guessing would produce a false refusal
		// on a correct change, so nothing is said.
		return
	}
	want := fmt.Sprintf("%v", doc.Scalar)
	for _, t := range targets {
		if fmt.Sprintf("%v", t) == want {
			return
		}
	}
	w.add(doc, s, leafrefNote(s, want, targets))
}

// evalConditions evaluates the "must" and "when" expressions attached to a
// node, within the subset the evaluator reads. An expression it cannot read
// produces NO finding: a condition guessed at is worse than one nobody checked,
// because the reader cannot tell them apart.
func (w *walker) evalConditions(doc *Node, s *yangschema.Node, ancestry []*Node) {
	for _, c := range s.Musts {
		result, known := evalXPath(c.Expr, evalContext{root: w.root, node: doc, ancestry: ancestry})
		if !known {
			w.rep.Skipped = append(w.rep.Skipped, w.doc.File+": condition not evaluated: "+c.Expr)
			continue
		}
		if !result {
			w.add(doc, s, mustNote(s, c))
		}
	}
	// A "when" that is false means the node should not be here AT ALL. That is
	// a warning rather than an error: the condition often depends on a leaf in
	// another file, and refusing a change on half a datastore is a false
	// refusal somebody cannot work around.
	for _, c := range s.Whens {
		result, known := evalXPath(c.Expr, evalContext{root: w.root, node: doc, ancestry: ancestry})
		if !known || result {
			continue
		}
		w.add(doc, s, whenNote(s, c))
	}
}

// checkMissing reports mandatory leaves and list keys that the document left
// out. It only speaks about a level the document has actually reached: an
// absent container is absent WITH its mandatory children, which is a decision
// rather than an omission.
func (w *walker) checkMissing(docNode *Node, schemaNodes []*yangschema.Node, present map[string]*Node, ancestry []*Node) {
	if len(docNode.Children) == 0 {
		return
	}
	for _, s := range schemaNodes {
		if !s.Mandatory || s.FeatureOff || !s.Editable() {
			continue
		}
		// A mandatory node inside a choice is only mandatory once its case has
		// been chosen; a mandatory choice is checked separately.
		if s.Choice != "" {
			continue
		}
		if n := present[strings.ToLower(s.Name)]; n != nil && !isEmpty(n.Scalar) {
			continue
		}
		// A "when" that does not hold means the node should not be present, so
		// its absence cannot be an omission.
		if len(s.Whens) > 0 {
			applies := false
			for _, c := range s.Whens {
				if result, known := evalXPath(c.Expr, evalContext{root: w.root, node: docNode, ancestry: ancestry}); !known || result {
					applies = true
					break
				}
			}
			if !applies {
				continue
			}
		}
		w.addAt(docNode, s, mandatoryNote(s, docNode.Name))
	}
}

// checkChoices enforces that one choice has at most one case filled in, and
// that a mandatory choice has one.
func (w *walker) checkChoices(docNode *Node, schemaNodes []*yangschema.Node, present map[string]*Node) {
	if len(docNode.Children) == 0 {
		return
	}
	type state struct {
		mandatory bool
		cases     map[string][]string
		node      *yangschema.Node
	}
	choices := map[string]*state{}
	for _, s := range schemaNodes {
		if s.Choice == "" {
			continue
		}
		st := choices[s.Choice]
		if st == nil {
			st = &state{cases: map[string][]string{}, node: s}
			choices[s.Choice] = st
		}
		if s.ChoiceMandatory {
			st.mandatory = true
		}
		if present[strings.ToLower(s.Name)] != nil {
			st.cases[s.Case] = append(st.cases[s.Case], s.Name)
		}
	}
	for name, st := range choices {
		switch {
		case len(st.cases) > 1:
			var picked []string
			for _, names := range st.cases {
				picked = append(picked, names...)
			}
			sort.Strings(picked)
			w.addAt(docNode, st.node, choiceBothNote(name, picked))
		case len(st.cases) == 0 && st.mandatory:
			w.addAt(docNode, st.node, choiceNoneNote(name))
		}
	}
}

func (w *walker) add(doc *Node, s *yangschema.Node, n note) {
	w.addAt(doc, s, n)
}

func (w *walker) addAt(doc *Node, s *yangschema.Node, n note) {
	f := Finding{
		Severity: n.severity, Rule: n.rule, Message: n.message,
		Because: n.because, Fix: n.fix, Detail: n.detail, Value: n.value,
		File: w.doc.File, Instance: w.doc.Instance, Engine: "native",
	}
	if doc != nil {
		f.Path, f.Line = doc.Path, doc.Line
	}
	if s != nil {
		f.Schema, f.Name = s.File, displayName(s)
	}
	if w.req.Locate != nil && f.Path != "" {
		if id, name, found := w.req.Locate(f.File, f.Path); found {
			f.ParamID = id
			if name != "" {
				f.Name = name
			}
		}
	}
	w.rep.Findings = append(w.rep.Findings, f)
}

func displayName(s *yangschema.Node) string {
	if s == nil {
		return ""
	}
	if s.Label != "" {
		return s.Label
	}
	return s.Name
}

// typeDetail states what the model said the type was, so a refusal can be
// checked against the schema rather than taken on trust.
func typeDetail(s *yangschema.Node) string {
	if s == nil || s.Type == nil {
		return ""
	}
	if s.Type.Qualified != "" {
		return "declared type: " + s.Type.Qualified
	}
	return "declared type: " + s.Type.Base
}

func isEmpty(v any) bool {
	if v == nil {
		return true
	}
	s, isStr := v.(string)
	return isStr && strings.TrimSpace(s) == ""
}

func summarize(vals []any) string {
	const show = 6
	parts := make([]string, 0, show)
	for i, v := range vals {
		if i == show {
			parts = append(parts, fmt.Sprintf("and %d more", len(vals)-show))
			break
		}
		parts = append(parts, fmt.Sprintf("%v", v))
	}
	if len(parts) == 0 {
		return "(nothing)"
	}
	return strings.Join(parts, ", ")
}

// sortFindings puts errors before warnings and groups by file, so the list
// reads as a work queue rather than the order a walk happened to take.
func sortFindings(f []Finding) {
	sort.SliceStable(f, func(i, j int) bool {
		if (f[i].Severity == SeverityError) != (f[j].Severity == SeverityError) {
			return f[i].Severity == SeverityError
		}
		if f[i].File != f[j].File {
			return f[i].File < f[j].File
		}
		return f[i].Line < f[j].Line
	})
}
