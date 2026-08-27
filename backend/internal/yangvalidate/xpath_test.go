package yangvalidate

// These tests are about the ONE promise this evaluator makes: it never answers
// a question it cannot actually read. Every case here was a false refusal on a
// correct document before it was a test.

import "testing"

// tree builds the document used throughout, plus the context of its "mode"
// leaf. The wrapper element matters: a repository file holds a fragment of a
// datastore, usually under a name the model never mentions.
func tree(t *testing.T) (root *Node, ctx evalContext) {
	t.Helper()
	root, err := Load("f.yaml", "yaml", []byte(
		"config:\n  radio:\n    cell:\n      - name: alpha\n        mode: fdd\n"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	cfg := root.Children[0]
	radio := cfg.Children[0]
	entry := radio.Child("cell").Entries[0]
	return root, evalContext{root: root, node: entry.Child("mode"),
		ancestry: []*Node{root, cfg, radio, entry}}
}

// An absolute path is written against the datastore root, and the file's own
// outermost element is not it. Anchoring at the root alone resolved every such
// path to nothing, and a leafref whose target was sitting three lines away was
// reported as naming something that does not exist.
func TestAbsolutePathAnchorsBelowAWrapper(t *testing.T) {
	root, _ := tree(t)
	nodes, approx, ok := resolvePath(evalContext{root: root, node: root}, "/rad:radio/rad:cell/rad:name")
	if !ok {
		t.Fatal("an absolute path whose subtree is in this file was not resolved")
	}
	if approx {
		t.Error("a path with no predicate was reported approximate")
	}
	if len(nodes) != 1 || nodes[0].Scalar != "alpha" {
		t.Fatalf("expected the one name leaf, got %d nodes", len(nodes))
	}
}

// The other half of the same rule: a subtree this file does not hold is a
// question it cannot answer, never a violation. This is the shape that made a
// "must" pointing at a profile defined in a sibling file refuse every change.
func TestAbsolutePathIntoAnotherFileIsUnknown(t *testing.T) {
	root, ctx := tree(t)
	if _, _, ok := resolvePath(evalContext{root: root, node: root}, "/profilecfg/gateway"); ok {
		t.Error("a subtree this file does not hold was answered rather than declined")
	}
	if _, known := evalXPath(
		"count(/profilecfg:profilecfg/profilecfg:gateway[profilecfg:gw-profile-tag = current()]) = 1",
		ctx); known {
		t.Error("a condition about another file was evaluated")
	}
}

// A wildcard is a step this subset cannot address. Resolving it to nothing made
// "count(...) = 1" read as "count 0 = 1", which is a refusal on every document
// including the ones that satisfy the rule.
func TestWildcardStepIsUnknownNotEmpty(t *testing.T) {
	_, ctx := tree(t)
	if _, known := evalXPath("count(../*[current() = .]) = 1", ctx); known {
		t.Error("an expression containing a wildcard was answered")
	}
}

// Stripping a predicate widens a node set. Widening is safe under equality and
// wrong under everything else, and count() is the case that turns it into a
// refusal.
func TestStrippedPredicateDeclinesWhereWideningWouldRefuse(t *testing.T) {
	_, ctx := tree(t)
	for _, expr := range []string{
		"count(/radio/cell[name = 'alpha']) = 1",
		"not(../../cell[name = 'alpha']/mode = 'tdd')",
		"string-length(../../cell[name = 'alpha']/name) < 4",
	} {
		if _, known := evalXPath(expr, ctx); known {
			t.Errorf("%q was answered from an approximate node set", expr)
		}
	}
}

// The subset it does read must keep working, or the fix above has simply turned
// the tier off.
func TestOrdinaryConditionsStillEvaluate(t *testing.T) {
	_, ctx := tree(t)
	cases := map[string]bool{
		"../mode = 'fdd'":            true,
		"../mode = 'tdd'":            false,
		"../name != 'beta'":          true,
		"count(../name) = 1":         true,
		"string-length(.) > 2":       true,
		"not(../mode = 'tdd')":       true,
		"/radio/cell/name = 'alpha'": true,
	}
	for expr, want := range cases {
		got, known := evalXPath(expr, ctx)
		if !known {
			t.Errorf("%q was not read at all", expr)
			continue
		}
		if got != want {
			t.Errorf("%q = %v, want %v", expr, got, want)
		}
	}
}

// A change is answerable for what it introduced. An objection the committed
// file already carried is reported and does not block, or a one-character edit
// arrives carrying somebody else's backlog.
func TestMarkPreExistingSubtractsTheBaseline(t *testing.T) {
	rep := Report{Findings: []Finding{
		{File: "a.xml", Rule: RuleMust, Message: "payload type must be unique", Severity: SeverityError},
		{File: "a.xml", Rule: RuleMust, Message: "payload type must be unique", Severity: SeverityError},
		{File: "a.xml", Rule: RuleType, Message: "not a port", Severity: SeverityError},
	}}
	MarkPreExisting(&rep, Report{Findings: []Finding{
		{File: "a.xml", Rule: RuleMust, Message: "payload type must be unique"},
	}})

	if n := len(rep.Inherited()); n != 1 {
		t.Fatalf("expected 1 inherited objection, got %d", n)
	}
	// One of the two duplicates is new, and the type error was never there.
	if n := len(rep.Errors()); n != 2 {
		t.Fatalf("expected 2 blocking errors, got %d", n)
	}
}
