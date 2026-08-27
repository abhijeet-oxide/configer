package region

import (
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// Ordering instances.
//
// A fleet is READ geographically. Somebody looking at fifty columns is looking
// for a place first and a name second, and an estate listed alphabetically puts
// Atlanta beside Anchorage and splits one site across the width of the screen.
// Sorted by name alone, "which sites carry this value" is a question the reader
// has to answer by hunting; sorted by place it is a question the picture
// answers.
//
// So every list of instances Configer draws - the grid's columns, the instances
// table, the geography rail, an instance picker - comes out in ONE order,
// applied once where the registry is loaded rather than re-derived per view:
//
//  1. by REGION, the way a US estate is always listed: east coast to west
//     coast, the order the time zones run. Regions outside the Americas follow,
//     each continent in turn, and within a continent the same east-to-west
//     reading.
//  2. within a region, by NAME, alphabetically.
//  3. and a name that ends in a number sorts by that NUMBER, so site-07 comes
//     before site-10 rather than after it. That is what "alphabetically" has
//     always meant to a person reading a list of machines.
//
// A region is placed by its coordinates (regions.yaml, a repository's own file
// winning as everywhere else). A region nobody has given coordinates to cannot
// be put in a geographic order honestly, so it follows the placed ones by name;
// an instance with no region at all comes last. Neither is hidden, and neither
// is guessed at.

// bandOf groups a longitude into the continental band it falls in, so the list
// runs the Americas first (where a US estate lives), then Europe and Africa,
// then Asia and the Pacific. Without it, sorting the whole world by longitude
// alone would open the list in Sydney.
func bandOf(lon float64) int {
	switch {
	case lon <= -30:
		return 0 // the Americas
	case lon < 40:
		return 1 // Europe and Africa
	default:
		return 2 // Asia and the Pacific
	}
}

// regionKey is everything the order needs to know about one instance's region:
// which tier it is in (placed / named but unplaced / none) and, when it is
// placed, where on earth it is.
type regionKey struct {
	tier int // 0 placed, 1 named but not placed, 2 no region at all
	band int
	lon  float64
	lat  float64
	name string // lower-cased region name, the tie-break inside a coordinate
}

// Key returns the ordering key for one instance's region. The region is the one
// somebody set; when nobody has, it is read out of the name by exactly the rule
// that would have filled the field in (Detect), so an estate that was never
// annotated still lists in the right order.
func (r Rules) Key(inst model.Instance) regionKey {
	name := strings.TrimSpace(inst.Region)
	if name == "" {
		name = r.Detect(inst.Name)
	}
	if name == "" {
		return regionKey{tier: 2}
	}
	lower := strings.ToLower(name)
	for _, rule := range r.rules {
		if rule.Lat == nil || rule.Lon == nil || strings.ToLower(rule.Region) != lower {
			continue
		}
		return regionKey{tier: 0, band: bandOf(*rule.Lon), lon: *rule.Lon, lat: *rule.Lat, name: lower}
	}
	return regionKey{tier: 1, name: lower}
}

// Less reports whether a sorts before b under the estate order described above.
func (r Rules) Less(a, b model.Instance) bool {
	ka, kb := r.Key(a), r.Key(b)
	if ka.tier != kb.tier {
		return ka.tier < kb.tier
	}
	if ka.tier == 0 {
		if ka.band != kb.band {
			return ka.band < kb.band
		}
		// East to west: the larger longitude is the more easterly one inside a
		// band, which is what puts Virginia ahead of Oregon.
		if ka.lon != kb.lon {
			return ka.lon > kb.lon
		}
		// Two sites on the same meridian read north to south.
		if ka.lat != kb.lat {
			return ka.lat > kb.lat
		}
	}
	if ka.name != kb.name {
		return ka.name < kb.name
	}
	return NaturalLess(a.Name, b.Name)
}

// Sort orders instances in place. It is STABLE, so two instances the rules
// cannot tell apart keep the order the registry gave them.
func (r Rules) Sort(insts []model.Instance) {
	sort.SliceStable(insts, func(i, j int) bool { return r.Less(insts[i], insts[j]) })
}

// SortNames orders bare instance names, for the callers that carry names rather
// than instances (a column layout, a list of targets). A name alone still
// answers Detect, which is where its region comes from.
func (r Rules) SortNames(names []string) {
	sort.SliceStable(names, func(i, j int) bool {
		return r.Less(model.Instance{Name: names[i]}, model.Instance{Name: names[j]})
	})
}

// NaturalLess compares two names the way a person reads a list of machines:
// text alphabetically, and a run of digits by its VALUE. "edge-7" before
// "edge-10" - byte order puts them the other way round, because "1" sorts
// before "7", and a fleet numbered past nine then reads as though somebody
// shuffled it.
//
// Leading zeros do not change a number's value, so "site-007" and "site-7" are
// equal here and the longer spelling is broken apart by the text that follows.
func NaturalLess(a, b string) bool {
	la, lb := strings.ToLower(a), strings.ToLower(b)
	i, j := 0, 0
	for i < len(la) && j < len(lb) {
		if isDigit(la[i]) && isDigit(lb[j]) {
			// Compare the digit runs as numbers: skip the leading zeros, then
			// the longer run is the larger number, and equal-length runs
			// compare digit by digit. No parsing, so an identifier carrying
			// forty digits cannot overflow anything.
			si, sj := i, j
			for i < len(la) && isDigit(la[i]) {
				i++
			}
			for j < len(lb) && isDigit(lb[j]) {
				j++
			}
			na, nb := trimZeros(la[si:i]), trimZeros(lb[sj:j])
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			if na != nb {
				return na < nb
			}
			continue
		}
		if la[i] != lb[j] {
			return la[i] < lb[j]
		}
		i++
		j++
	}
	if len(la)-i != len(lb)-j {
		return len(la)-i < len(lb)-j
	}
	// Same reading, different spelling ("site-07" vs "site-7"): settle it so
	// the sort is total, and case is the last thing that decides.
	return a < b
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func trimZeros(s string) string {
	for len(s) > 1 && s[0] == '0' {
		s = s[1:]
	}
	return s
}
