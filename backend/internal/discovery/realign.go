package discovery

import (
	"fmt"
	"regexp"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
)

// Realign says what an edit did to a file's settings - which are NEW, which are
// the same setting at a different address, and which are gone - by lining the
// two versions up as sequences rather than comparing their paths.
//
// The distinction is the whole point, and positional addressing is why. A
// repeated structure is addressed by position (`net-info[3]`, `servers[2]`), so
// inserting one entry in the MIDDLE renumbers every entry below it. Compare the
// two versions by path and that reads as: a handful of settings appearing at the
// end, a couple of paths vanishing, and - silently - a dozen bindings still
// resolving but now describing a different thing than their name says. A person
// who added one network is told they added six, two of their parameters point at
// nothing, and `net-info[3].net-id` has quietly become a different network's id.
//
// Lining the sequences up instead gives the answer the person would give: one
// entry was inserted, and everything below it moved down one place.
//
// Both sides must be in DOCUMENT ORDER, which is what every parser here emits.
type Realignment struct {
	// Added are settings the file did not have before, at the paths they now
	// occupy, ready to become parameters.
	Added []model.Parameter
	// Moved are settings that are still the same setting, at a new path. The
	// catalog follows them; no value changes.
	Moved []Move
	// Removed are the paths of settings the edit took out of the file.
	Removed []string
}

// Move is one setting's address changing while the setting itself does not.
type Move struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// maxAlign caps the alignment. The common prefix and suffix are trimmed first,
// so an edit to one entry of a ten-thousand-setting file reduces to a handful of
// candidates either side; only a file rewritten end to end can reach the cap,
// and there "what moved where" is not a question worth an O(n*m) answer.
const maxAlign = 4000

// Realign compares a file's settings before and after an edit. Both candidate
// lists are filtered through Tunable first, so this asks the same question of
// both versions that an import would ask of either.
func Realign(file string, before, after []plugin.Candidate) Realignment {
	old := Tunable(file, before)
	next := Tunable(file, after)

	// A setting is recognized across the two versions by what it IS - its leaf
	// name and its value - not by where it sits. That is exactly the information
	// an index destroys.
	key := func(p model.Parameter) string {
		return leafOf(p.Name) + "\x00" + fmt.Sprintf("%v", p.Default)
	}
	oldKeys := make([]string, len(old))
	for i, p := range old {
		oldKeys[i] = key(p)
	}
	newKeys := make([]string, len(next))
	for i, p := range next {
		newKeys[i] = key(p)
	}

	// Trim the run of identical settings at each end. An edit touches one part
	// of a file; everything above and below it lines up trivially, and taking it
	// out first is what keeps this cheap on a real estate.
	head := 0
	for head < len(oldKeys) && head < len(newKeys) && oldKeys[head] == newKeys[head] {
		head++
	}
	tail := 0
	for tail < len(oldKeys)-head && tail < len(newKeys)-head &&
		oldKeys[len(oldKeys)-1-tail] == newKeys[len(newKeys)-1-tail] {
		tail++
	}
	oldMid, newMid := old[head:len(old)-tail], next[head:len(next)-tail]
	oldMidKeys, newMidKeys := oldKeys[head:len(oldKeys)-tail], newKeys[head:len(newKeys)-tail]

	var out Realignment
	// The trimmed head and tail are pairwise matches by construction.
	addMove := func(from, to model.Parameter) {
		f, t := from.Bindings[0].Path, to.Bindings[0].Path
		if f != t {
			out.Moved = append(out.Moved, Move{From: f, To: t})
		}
	}
	for i := 0; i < head; i++ {
		addMove(old[i], next[i])
	}
	for i := 0; i < tail; i++ {
		addMove(old[len(old)-1-i], next[len(next)-1-i])
	}

	if len(oldMid) > maxAlign || len(newMid) > maxAlign {
		// Too much moved at once to say what became what. Fall back to the
		// honest, cheap answer: paths the file did not have before are new,
		// paths it no longer has are gone, and nothing claims to have moved.
		return coarse(out, oldMid, newMid)
	}

	pairs := lcsPairs(oldMidKeys, newMidKeys)
	matchedOld := make([]bool, len(oldMid))
	matchedNew := make([]bool, len(newMid))
	for _, pr := range pairs {
		matchedOld[pr[0]], matchedNew[pr[1]] = true, true
		addMove(oldMid[pr[0]], newMid[pr[1]])
	}
	for i, p := range newMid {
		if !matchedNew[i] {
			out.Added = append(out.Added, p)
		}
	}
	for i, p := range oldMid {
		if !matchedOld[i] {
			out.Removed = append(out.Removed, p.Bindings[0].Path)
		}
	}

	// A setting whose VALUE was edited reads as one removal plus one addition at
	// the same path. It is neither: it is the same setting, still there. Pair
	// those back up so an ordinary value edit never proposes a parameter for a
	// key that is already managed.
	out.dropSamePathChurn()
	return out
}

// dropSamePathChurn removes add/remove pairs that share a path - the shape a
// plain value edit takes once both sides are keyed by value.
func (r *Realignment) dropSamePathChurn() {
	if len(r.Added) == 0 || len(r.Removed) == 0 {
		return
	}
	gone := make(map[string]int, len(r.Removed))
	for _, p := range r.Removed {
		gone[p]++
	}
	kept := r.Added[:0]
	for _, p := range r.Added {
		path := p.Bindings[0].Path
		if gone[path] > 0 {
			gone[path]--
			continue
		}
		kept = append(kept, p)
	}
	r.Added = kept
	rest := r.Removed[:0]
	for _, p := range r.Removed {
		if gone[p] > 0 {
			gone[p]--
			rest = append(rest, p)
		}
	}
	r.Removed = rest
}

// coarse is the path-comparison answer, used when the edit is too large to
// align. It never reports a move, so nothing is re-pointed on a guess.
func coarse(out Realignment, old, next []model.Parameter) Realignment {
	had := make(map[string]bool, len(old))
	for _, p := range old {
		had[p.Bindings[0].Path] = true
	}
	has := make(map[string]bool, len(next))
	for _, p := range next {
		has[p.Bindings[0].Path] = true
		if !had[p.Bindings[0].Path] {
			out.Added = append(out.Added, p)
		}
	}
	for _, p := range old {
		if !has[p.Bindings[0].Path] {
			out.Removed = append(out.Removed, p.Bindings[0].Path)
		}
	}
	return out
}

// lcsPairs returns the index pairs of a longest common subsequence of a and b.
// It is the classic table, kept because the inputs reaching it are already
// trimmed to the part of the file that actually changed.
func lcsPairs(a, b []string) [][2]int {
	if len(a) == 0 || len(b) == 0 {
		return nil
	}
	// table[i][j] = LCS length of a[i:] and b[j:]
	table := make([][]int, len(a)+1)
	for i := range table {
		table[i] = make([]int, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				table[i][j] = table[i+1][j+1] + 1
			} else if table[i+1][j] >= table[i][j+1] {
				table[i][j] = table[i+1][j]
			} else {
				table[i][j] = table[i][j+1]
			}
		}
	}
	var out [][2]int
	for i, j := 0, 0; i < len(a) && j < len(b); {
		switch {
		case a[i] == b[j]:
			out = append(out, [2]int{i, j})
			i, j = i+1, j+1
		case table[i+1][j] >= table[i][j+1]:
			i++
		default:
			j++
		}
	}
	return out
}

// SameEntry reports whether two paths address the same setting under different
// positions of the same repeated structure - "net-info[3]/net-id" and
// "net-info[4]/net-id". It is what tells a genuine relocation apart from an
// unrelated pair of paths that happen to align, so a re-point can be refused
// when the two are not the same thing in different places.
func SameEntry(from, to string) bool {
	return stripIndices(from) == stripIndices(to)
}

var anyIndex = regexp.MustCompile(`\[\d+\]`)

func stripIndices(path string) string { return anyIndex.ReplaceAllString(path, "[]") }
