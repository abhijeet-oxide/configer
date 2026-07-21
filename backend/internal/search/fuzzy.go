package search

import "strings"

// fuzzyScore mirrors frontend/src/search/fuzzy.ts so the in-memory candidate
// scan behaves the same on both sides. Higher is better; ok=false means no
// match. It rewards contiguous substrings over scattered subsequences and
// word-boundary/prefix matches over mid-word ones. Identifiers here are ASCII
// (parameter names, instance names), so byte indexing is sufficient.
func fuzzyScore(query, text string) (float64, bool) {
	if query == "" {
		return 0, true
	}
	q := strings.ToLower(query)
	t := strings.ToLower(text)

	if idx := strings.Index(t, q); idx != -1 {
		s := 900.0 - float64(idx)
		if isBoundary(t, idx-1) {
			s += 120
		}
		if t == q {
			s += 400
		}
		return s - float64(len(t)-len(q))*0.5, true
	}

	ti := 0
	score := 0.0
	prev := -2
	for i := 0; i < len(q); i++ {
		c := q[i]
		hit := -1
		for ti < len(t) {
			if t[ti] == c {
				hit = ti
				break
			}
			ti++
		}
		if hit == -1 {
			return 0, false
		}
		score += 10
		if hit == prev+1 {
			score += 8
		}
		if isBoundary(t, hit-1) {
			score += 6
		}
		prev = hit
		ti = hit + 1
	}
	return score - float64(len(t))*0.1, true
}

// isBoundary reports whether the character before position i starts a new word
// (the start of the string, or any non-alphanumeric separator).
func isBoundary(t string, i int) bool {
	if i < 0 {
		return true
	}
	ch := t[i]
	if ch >= 'a' && ch <= 'z' {
		return false
	}
	if ch >= '0' && ch <= '9' {
		return false
	}
	return true
}

// bestScore is the max fuzzy score of a query across the title (weighted) and
// the keyword haystack; ok=false when neither matches.
func bestScore(query, title, keywords string) (float64, bool) {
	best := 0.0
	found := false
	if s, ok := fuzzyScore(query, title); ok {
		best = s * 2
		found = true
	}
	if s, ok := fuzzyScore(query, keywords); ok && s > best {
		best = s
		found = true
	}
	return best, found
}
