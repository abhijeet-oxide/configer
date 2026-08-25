package yangschema

// A DEVIATION is a vendor saying "the standard model says this, my box does
// something else". It is the one YANG statement whose whole purpose is to make
// the model disagree with itself, and reading the model without applying them
// produces rules that are confidently wrong: a leaf the platform does not
// support at all still offered for editing, a range the device narrowed still
// advertised at its original width, a mandatory leaf that this build made
// optional still refusing to save.
//
// Deviations are applied AFTER the whole set is indexed, because a deviation
// routinely targets a node another file declares - that is the point of it.

import "strings"

// deviation is one parsed "deviation" statement: the absolute route it targets
// and the changes it makes there.
type deviation struct {
	target []string
	st     *Statement
}

// collectDeviations reads every module-level deviation in a parsed tree.
func collectDeviations(st *Statement, out []deviation) []deviation {
	for _, sub := range st.Sub {
		if sub.Name() != "deviation" || sub.Arg == "" {
			continue
		}
		steps := routeSteps(sub.Arg)
		if len(steps) == 0 {
			continue
		}
		out = append(out, deviation{target: steps, st: sub})
	}
	return out
}

// routeSteps splits a schema route ("/if:interfaces/if:interface/if:mtu") into
// bare, lowercased name steps - the same shape the index is keyed by.
func routeSteps(arg string) []string {
	var steps []string
	for _, s := range strings.Split(arg, "/") {
		s = strings.TrimSpace(s)
		if i := strings.IndexByte(s, '['); i >= 0 {
			s = s[:i]
		}
		if s = bare(s); s != "" {
			steps = append(steps, strings.ToLower(s))
		}
	}
	return steps
}

// applyDeviations rewrites the indexed tree so it says what the device
// actually does. Returns the nodes that "not-supported" removed, so the caller
// can drop them from the index.
func (s *Set) applyDeviations(devs []deviation, defs *definitions) map[*Node]bool {
	removed := map[*Node]bool{}
	for _, d := range devs {
		target := s.byRoute(d.target)
		if target == nil {
			// A deviation for a node this set does not carry is not an error:
			// vendors ship one deviation module covering several products.
			continue
		}
		for _, dev := range d.st.Children("deviate") {
			switch strings.TrimSpace(dev.Arg) {
			case "not-supported":
				markRemoved(target, removed)
			case "add", "replace":
				applyDeviate(target, dev, defs, true)
			case "delete":
				applyDeviate(target, dev, defs, false)
			}
		}
	}
	return removed
}

func markRemoved(n *Node, removed map[*Node]bool) {
	removed[n] = true
	for _, c := range n.Children {
		markRemoved(c, removed)
	}
}

// applyDeviate applies one "deviate" body. set=false is the "delete" form,
// which takes a property back off rather than putting one on.
func applyDeviate(n *Node, dev *Statement, defs *definitions, set bool) {
	if !set {
		if dev.Child("default") != nil {
			n.Default = ""
		}
		if dev.Child("units") != nil {
			n.Units = ""
		}
		if dev.Child("mandatory") != nil {
			n.Mandatory = false
		}
		if dev.Child("min-elements") != nil {
			n.MinElements = nil
		}
		if dev.Child("max-elements") != nil {
			n.MaxElements = nil
		}
		// A deleted "must" takes its wording and its dependency with it.
		for _, m := range dev.Children("must") {
			n.dropMust(m.Arg)
		}
		return
	}
	if v := dev.ChildArg("default"); v != "" {
		n.Default = v
	}
	if v := dev.ChildArg("units"); v != "" {
		n.Units = v
	}
	if v := dev.ChildArg("mandatory"); v != "" {
		n.Mandatory = v == "true"
	}
	if v := dev.ChildArg("config"); v != "" {
		n.Config = v != "false"
	}
	if v, found := parseInt(dev.ChildArg("min-elements")); found {
		n.MinElements = &v
	}
	if v, found := parseInt(dev.ChildArg("max-elements")); found {
		n.MaxElements = &v
	}
	// A deviated TYPE replaces the original outright: the device's own
	// restriction is the only one that holds on the device.
	if t := dev.Child("type"); t != nil {
		if resolved := resolveType(t, defs, 0); resolved != nil {
			n.Type = resolved
		}
	}
	for _, m := range dev.Children("must") {
		n.addMust(m)
	}
	for _, u := range dev.Children("unique") {
		if u.Arg != "" {
			n.Uniques = appendUniqueList(n.Uniques, strings.Fields(u.Arg))
		}
	}
}

// byRoute finds the indexed node at an exact route from a module root. Unlike
// Lookup, this is not a suffix match: a deviation names the whole route, and
// applying one to a node that merely ends the same way would rewrite the wrong
// setting.
func (s *Set) byRoute(steps []string) *Node {
	if len(steps) == 0 {
		return nil
	}
	leaf := steps[len(steps)-1]
	for _, idx := range s.byLeaf[leaf] {
		e := s.entries[idx]
		if len(e.path) != len(steps) {
			continue
		}
		same := true
		for i := range steps {
			if e.path[i] != steps[i] {
				same = false
				break
			}
		}
		if same {
			return e.node
		}
	}
	return nil
}

func appendUniqueList(lists [][]string, add []string) [][]string {
	key := strings.Join(add, " ")
	for _, l := range lists {
		if strings.Join(l, " ") == key {
			return lists
		}
	}
	return append(lists, add)
}
