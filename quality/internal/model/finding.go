// Package model is the normalized vocabulary of the Continuous Quality
// Platform. Every analyzer, whatever tool produced it, is reduced to the types
// in this file, and every reporter reads only these types. Nothing downstream
// of normalization knows which tool spoke.
package model

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

// Severity is deliberately the SARIF ladder plus a "blocker" step, because
// SARIF is what the whole ecosystem already emits and what GitHub ingests.
type Severity string

const (
	SeverityBlocker Severity = "blocker" // a budget was breached; the gate fails
	SeverityError   Severity = "error"
	SeverityWarning Severity = "warning"
	SeverityNote    Severity = "note"
	SeverityInfo    Severity = "info"
)

var severityRank = map[Severity]int{
	SeverityBlocker: 4, SeverityError: 3, SeverityWarning: 2, SeverityNote: 1, SeverityInfo: 0,
}

// Rank orders severities; higher is worse. Unknown severities sort as info.
func (s Severity) Rank() int { return severityRank[s] }

// AtLeast reports whether s is as bad as or worse than min.
func (s Severity) AtLeast(min Severity) bool { return s.Rank() >= min.Rank() }

// ParseSeverity maps the spellings the various tools use onto the ladder.
func ParseSeverity(s string) Severity {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "blocker", "critical", "fatal":
		return SeverityBlocker
	case "error", "high", "severe", "2":
		return SeverityError
	case "warning", "warn", "medium", "moderate", "1":
		return SeverityWarning
	case "note", "low", "minor", "info-low":
		return SeverityNote
	default:
		return SeverityInfo
	}
}

// Confidence says how much the platform trusts the finding. It is the number an
// AI agent should read before deciding to act unattended: Google's Tricorder
// keeps its analyzers under a 10% effective false-positive rate precisely
// because developers stop reading a channel that cries wolf, and an agent that
// auto-fixes a false positive is worse than a developer who ignores one.
type Confidence string

const (
	ConfidenceHigh   Confidence = "high"   // deterministic; the tool cannot be wrong about it
	ConfidenceMedium Confidence = "medium" // heuristic, but rarely wrong in practice
	ConfidenceLow    Confidence = "low"    // needs a human to look
)

// Category groups findings the way the people reading them think, not the way
// the tools are packaged.
type Category string

const (
	CategoryFrontend       Category = "frontend"
	CategoryBackend        Category = "backend"
	CategoryAPI            Category = "api"
	CategorySecurity       Category = "security"
	CategoryInfrastructure Category = "infrastructure"
	CategoryTests          Category = "tests"
	CategoryGeneral        Category = "general"
)

// AllCategories is the display order used by every reporter.
var AllCategories = []Category{
	CategoryFrontend, CategoryBackend, CategoryAPI, CategorySecurity,
	CategoryInfrastructure, CategoryTests, CategoryGeneral,
}

// Location is where a finding lives. Path is always repository-relative and
// slash-separated so a report generated on a CI runner is still clickable on a
// developer's laptop.
type Location struct {
	Path      string `json:"path"`
	Line      int    `json:"line,omitempty"`
	EndLine   int    `json:"endLine,omitempty"`
	Column    int    `json:"column,omitempty"`
	Symbol    string `json:"symbol,omitempty"`
	Component string `json:"component,omitempty"` // React component, Go func, endpoint, chart
}

func (l Location) String() string {
	if l.Line > 0 {
		return fmt.Sprintf("%s:%d", l.Path, l.Line)
	}
	return l.Path
}

// Fix is the remediation half of a finding. SafeToAutomate is the single most
// important field for an autonomous agent: it is the platform's statement that
// applying this change without a human in the loop is expected to be correct.
// It is set by the analyzer manifest, never guessed per finding.
type Fix struct {
	Recommendation string `json:"recommendation"`
	SafeToAutomate bool   `json:"safeToAutomate"`
	Effort         string `json:"effort,omitempty"` // trivial | small | medium | large
	Patch          string `json:"patch,omitempty"`  // unified diff when the tool supplied one
	DocsURL        string `json:"docsUrl,omitempty"`
}

// Finding is one normalized issue. It is the unit an AI agent acts on, so every
// field is either something the agent needs to decide, or something it needs to
// make the edit. Raw tool output never reaches here; it stays in Artifacts.
type Finding struct {
	// Fingerprint is stable across runs and across tools reporting the same
	// thing, which is what makes deduplication and baselining possible.
	Fingerprint string `json:"id"`

	Analyzer string     `json:"analyzer"`
	Rule     string     `json:"rule,omitempty"`
	Category Category   `json:"category"`
	Severity Severity   `json:"severity"`
	Conf     Confidence `json:"confidence"`

	Title    string     `json:"title"`
	Detail   string     `json:"detail,omitempty"`
	Where    []Location `json:"where,omitempty"`
	Evidence string     `json:"evidence,omitempty"` // one short quotation, never a log

	Fix Fix `json:"fix"`

	// Tools is every analyzer that independently reported this finding. Two
	// tools agreeing is a real confidence signal, so it survives the merge.
	Tools []string `json:"tools,omitempty"`
	// Occurrences counts how many raw results collapsed into this one.
	Occurrences int `json:"occurrences,omitempty"`
	// New is true when the finding is absent from the baseline. On a pull
	// request this is the field that decides whether anyone is asked to care.
	New bool `json:"new,omitempty"`
	// Tags carry analyzer-declared labels through to the PR labeller.
	Tags []string `json:"tags,omitempty"`
}

// PrimaryPath is the file a reader should open first.
func (f Finding) PrimaryPath() string {
	if len(f.Where) == 0 {
		return ""
	}
	return f.Where[0].Path
}

// ComputeFingerprint derives the stable identity of a finding. It deliberately
// excludes the line number: a finding that moved because somebody added an
// import above it is the same finding, and a fingerprint that changes on every
// reformat makes the baseline worthless. Rule + file + a normalized title is
// what survives ordinary editing.
func ComputeFingerprint(rule, path, title string) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%s\x00%s", strings.ToLower(rule), path, normalizeTitle(title))
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// normalizeTitle strips the parts of a message that vary run to run (numbers,
// quoted identifiers keep their quotes but not their contents are not touched
// here) so "took 812ms" and "took 830ms" fingerprint alike.
func normalizeTitle(s string) string {
	var b strings.Builder
	inNum := false
	for _, r := range strings.ToLower(s) {
		if r >= '0' && r <= '9' {
			if !inNum {
				b.WriteByte('#')
				inNum = true
			}
			continue
		}
		inNum = false
		b.WriteRune(r)
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// EnsureFingerprint fills in a missing fingerprint from the finding's own parts.
func (f *Finding) EnsureFingerprint() {
	if f.Fingerprint == "" {
		f.Fingerprint = ComputeFingerprint(f.Rule, f.PrimaryPath(), f.Title)
	}
}

// SortFindings orders findings the way a reader wants them: worst first, then
// by confidence, then stably by location so two runs of the same code produce
// byte-identical reports (which is what makes the report diffable).
func SortFindings(fs []Finding) {
	confRank := map[Confidence]int{ConfidenceHigh: 2, ConfidenceMedium: 1, ConfidenceLow: 0}
	sort.SliceStable(fs, func(i, j int) bool {
		a, b := fs[i], fs[j]
		if a.Severity.Rank() != b.Severity.Rank() {
			return a.Severity.Rank() > b.Severity.Rank()
		}
		if a.New != b.New {
			return a.New
		}
		if confRank[a.Conf] != confRank[b.Conf] {
			return confRank[a.Conf] > confRank[b.Conf]
		}
		if a.PrimaryPath() != b.PrimaryPath() {
			return a.PrimaryPath() < b.PrimaryPath()
		}
		return a.Fingerprint < b.Fingerprint
	})
}
