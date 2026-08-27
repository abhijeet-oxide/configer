package region

import (
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

func names(insts []model.Instance) []string {
	out := make([]string, len(insts))
	for i, in := range insts {
		out[i] = in.Name
	}
	return out
}

func eq(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestAnEstateReadsEastToWest(t *testing.T) {
	r := Load(t.TempDir())
	insts := []model.Instance{
		{Name: "c", Region: "Oregon (us-west-2)"},
		{Name: "a", Region: "N. Virginia (us-east-1)"},
		{Name: "b", Region: "Kansas City"},
	}
	r.Sort(insts)
	eq(t, names(insts), []string{"a", "b", "c"})
}

func TestOneRegionReadsAlphabeticallyAndThenByNumber(t *testing.T) {
	r := Load(t.TempDir())
	insts := []model.Instance{
		{Name: "edge-10", Region: "Texas"},
		{Name: "edge-2", Region: "Texas"},
		{Name: "core-9", Region: "Texas"},
		{Name: "edge-1", Region: "Texas"},
	}
	r.Sort(insts)
	// A run of digits sorts by its VALUE: edge-2 before edge-10, which byte
	// order gets backwards.
	eq(t, names(insts), []string{"core-9", "edge-1", "edge-2", "edge-10"})
}

func TestARegionNobodySetIsReadOutOfTheName(t *testing.T) {
	r := Load(t.TempDir())
	// Nothing here carries a region field; the site code in each name is what
	// places it. Warrenville (-88.2) is east of Sherman Oaks (-118.4).
	insts := []model.Instance{
		{Name: "sho0001a"},
		{Name: "wnv0002a"},
		{Name: "wnv0001a"},
	}
	r.Sort(insts)
	eq(t, names(insts), []string{"wnv0001a", "wnv0002a", "sho0001a"})
}

func TestWhatCannotBePlacedComesAfterWhatCan(t *testing.T) {
	r := Load(t.TempDir())
	insts := []model.Instance{
		{Name: "nowhere"},                   // no region at all: last
		{Name: "named", Region: "Neptune"},  // named, but nothing places it
		{Name: "placed", Region: "Oakland"}, // on the map: first
	}
	r.Sort(insts)
	eq(t, names(insts), []string{"placed", "named", "nowhere"})
}

func TestContinentsRunTheWayAUSEstateReadsThem(t *testing.T) {
	r := Load(t.TempDir())
	insts := []model.Instance{
		{Name: "tokyo", Region: "Tokyo (ap-northeast-1)"},
		{Name: "dublin", Region: "Ireland (eu-west-1)"},
		{Name: "ohio", Region: "Ohio (us-east-2)"},
		{Name: "frankfurt", Region: "Frankfurt (eu-central-1)"},
	}
	r.Sort(insts)
	// The Americas first, then Europe (east to west inside it), then Asia.
	eq(t, names(insts), []string{"ohio", "frankfurt", "dublin", "tokyo"})
}

func TestNaturalLessReadsNumbersAsNumbers(t *testing.T) {
	for _, c := range []struct{ a, b string }{
		{"site-7", "site-10"},
		{"site-007", "site-10"},
		{"a2b", "a10b"},
		{"alpha", "beta"},
		{"node1", "node1a"},
	} {
		if !NaturalLess(c.a, c.b) {
			t.Errorf("NaturalLess(%q, %q) = false, want true", c.a, c.b)
		}
		if NaturalLess(c.b, c.a) {
			t.Errorf("NaturalLess(%q, %q) = true, want false", c.b, c.a)
		}
	}
}
