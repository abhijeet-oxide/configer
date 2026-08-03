// Package dedupe collapses the same problem reported many times into one
// finding. This is not cosmetic. Running several overlapping tools on purpose
// (golangci-lint and Semgrep both flag an ignored error; Trivy and OSV-Scanner
// both know about CVE-2025-1234) is how coverage is achieved, and without a
// merge step that choice would triple the size of the report and triple what an
// agent pays to read it.
package dedupe

import (
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

// Merge collapses duplicates and returns the surviving findings.
//
// Two passes, in this order:
//
//  1. Exact fingerprint. Same rule, same file, same normalized message. This is
//     the same tool reporting the same thing twice, usually because it ran over
//     overlapping file sets.
//  2. Same location and same meaning. Different tools, different rule ids, same
//     line and a message that reduces to the same shape. This is the expensive
//     one and it is the one that pays.
//
// A merge keeps the WORST severity and the BEST confidence, and records every
// tool that reported it. Two independent tools agreeing is real evidence, and
// the report says so rather than throwing the corroboration away.
func Merge(findings []model.Finding) []model.Finding {
	byFingerprint := map[string]*model.Finding{}
	order := []string{}
	for i := range findings {
		f := findings[i]
		f.EnsureFingerprint()
		if existing, ok := byFingerprint[f.Fingerprint]; ok {
			absorb(existing, f)
			continue
		}
		copied := f
		byFingerprint[f.Fingerprint] = &copied
		order = append(order, f.Fingerprint)
	}

	first := make([]model.Finding, 0, len(order))
	for _, fp := range order {
		first = append(first, *byFingerprint[fp])
	}

	// Second pass: cross-tool. Findings are bucketed by exact location, and
	// within a bucket two findings merge when their messages MEAN the same
	// thing. Meaning is approximated by word overlap after the filler is
	// stripped, because two tools describing one defect ("error return value is
	// not checked" and "unchecked error return value") share their nouns and
	// share nothing with an unrelated problem on the same line.
	//
	// An exact-shape key was tried first and is not enough: it requires the two
	// tools to have chosen the same words, which they rarely do.
	buckets := map[string][]int{}
	var loose []int
	for i := range first {
		key := locationKey(first[i])
		if key == "" {
			loose = append(loose, i)
			continue
		}
		buckets[key] = append(buckets[key], i)
	}

	merged := make([]bool, len(first))
	for _, idxs := range buckets {
		for a := 0; a < len(idxs); a++ {
			if merged[idxs[a]] {
				continue
			}
			for b := a + 1; b < len(idxs); b++ {
				if merged[idxs[b]] {
					continue
				}
				if !sameMeaning(first[idxs[a]].Title, first[idxs[b]].Title) {
					continue
				}
				absorb(&first[idxs[a]], first[idxs[b]])
				merged[idxs[b]] = true
			}
		}
	}

	out := make([]model.Finding, 0, len(first))
	for i := range first {
		if !merged[i] {
			out = append(out, first[i])
		}
	}
	_ = loose
	model.SortFindings(out)
	return out
}

// sameMeaning decides whether two diagnostics at the same place describe one
// defect. The threshold is half the distinctive words: high enough that two
// unrelated problems on one line stay apart, low enough that two tools'
// phrasings of the same problem come together.
const meaningThreshold = 0.5

func sameMeaning(a, b string) bool {
	wa, wb := distinctive(a), distinctive(b)
	if len(wa) == 0 || len(wb) == 0 {
		return false
	}
	shared := 0
	for w := range wa {
		if wb[w] {
			shared++
		}
	}
	union := len(wa) + len(wb) - shared
	if union == 0 {
		return false
	}
	return float64(shared)/float64(union) >= meaningThreshold
}

// absorb folds src into dst, keeping the strongest claim from each.
func absorb(dst *model.Finding, src model.Finding) {
	if src.Severity.Rank() > dst.Severity.Rank() {
		dst.Severity = src.Severity
	}
	if confRank(src.Conf) > confRank(dst.Conf) {
		dst.Conf = src.Conf
	}
	dst.Occurrences += max(src.Occurrences, 1)
	dst.Tools = mergeStrings(dst.Tools, src.Tools)
	dst.Tags = mergeStrings(dst.Tags, src.Tags)
	// A second tool corroborating raises confidence: two independent
	// implementations rarely share a false positive.
	if len(dst.Tools) > 1 && dst.Conf != model.ConfidenceHigh {
		dst.Conf = model.ConfidenceHigh
	}
	// Keep the more actionable remediation. A concrete patch beats prose, and
	// prose beats nothing.
	if dst.Fix.Patch == "" && src.Fix.Patch != "" {
		dst.Fix.Patch = src.Fix.Patch
	}
	if len(src.Fix.Recommendation) > len(dst.Fix.Recommendation) {
		dst.Fix.Recommendation = src.Fix.Recommendation
	}
	if dst.Fix.DocsURL == "" {
		dst.Fix.DocsURL = src.Fix.DocsURL
	}
	// Automation safety is a floor, not an average: if either tool says this is
	// not safe to apply unattended, it is not.
	dst.Fix.SafeToAutomate = dst.Fix.SafeToAutomate && src.Fix.SafeToAutomate
	if dst.Evidence == "" {
		dst.Evidence = src.Evidence
	}
	if dst.Detail == "" {
		dst.Detail = src.Detail
	}
	dst.Where = mergeLocations(dst.Where, src.Where)
	dst.New = dst.New || src.New
}

// locationKey is the cross-tool identity: file, line, and the message reduced
// to its distinctive words. An empty key means "do not merge this one", which
// is the right answer for a finding with no location.
func locationKey(f model.Finding) string {
	if len(f.Where) == 0 || f.Where[0].Path == "" || f.Where[0].Line == 0 {
		return ""
	}
	w := f.Where[0]
	return strings.Join([]string{w.Path, itoa(w.Line), string(f.Category)}, "\x00")
}

// stopWords are the words that carry no discriminating meaning in a diagnostic.
// Removing them is what lets two tools' phrasings of one problem collide.
var stopWords = map[string]bool{
	"a": true, "an": true, "the": true, "is": true, "are": true, "was": true,
	"be": true, "to": true, "of": true, "in": true, "on": true, "for": true,
	"this": true, "that": true, "it": true, "and": true, "or": true, "not": true,
	"should": true, "must": true, "may": true, "can": true, "will": true,
	"error": true, "warning": true, "found": true, "detected": true,
}

// distinctive reduces a message to the words that carry its meaning: no filler,
// no numbers, nothing shorter than three characters.
func distinctive(title string) map[string]bool {
	words := strings.FieldsFunc(strings.ToLower(title), func(r rune) bool {
		return !(r >= 'a' && r <= 'z')
	})
	out := make(map[string]bool, len(words))
	for _, w := range words {
		if len(w) < 3 || stopWords[w] {
			continue
		}
		out[w] = true
	}
	return out
}

func confRank(c model.Confidence) int {
	switch c {
	case model.ConfidenceHigh:
		return 2
	case model.ConfidenceMedium:
		return 1
	default:
		return 0
	}
}

func mergeStrings(a, b []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(a)+len(b))
	for _, s := range append(append([]string{}, a...), b...) {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

func mergeLocations(a, b []model.Location) []model.Location {
	seen := map[string]bool{}
	out := make([]model.Location, 0, len(a)+len(b))
	for _, l := range append(append([]model.Location{}, a...), b...) {
		k := l.Path + ":" + itoa(l.Line) + ":" + l.Symbol
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, l)
	}
	// More than a handful of locations on one finding is a report nobody reads;
	// the artifact keeps the rest.
	if len(out) > 8 {
		out = out[:8]
	}
	return out
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
