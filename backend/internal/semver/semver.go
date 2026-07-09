// Package semver provides a minimal, dependency-free version comparison good
// enough for software-version gating (e.g. "v24.3.1" vs "v1.0.0").
package semver

import (
	"strconv"
	"strings"
)

// Compare returns -1 if a<b, 0 if a==b, +1 if a>b. Non-numeric or missing
// components are treated as 0. A leading "v" is ignored.
func Compare(a, b string) int {
	pa := parts(a)
	pb := parts(b)
	n := len(pa)
	if len(pb) > n {
		n = len(pb)
	}
	for i := 0; i < n; i++ {
		va, vb := 0, 0
		if i < len(pa) {
			va = pa[i]
		}
		if i < len(pb) {
			vb = pb[i]
		}
		if va < vb {
			return -1
		}
		if va > vb {
			return 1
		}
	}
	return 0
}

func parts(v string) []int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if v == "" {
		return nil
	}
	// stop at any pre-release/build suffix
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	segs := strings.Split(v, ".")
	out := make([]int, 0, len(segs))
	for _, s := range segs {
		n, _ := strconv.Atoi(s)
		out = append(out, n)
	}
	return out
}
