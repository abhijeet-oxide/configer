// Package recognizers holds the built-in generated-file recognizers: given a
// file, what tool produced it, what will produce it again, and where the same
// change belongs so that it survives.
//
// Configer passes generated files over by default. That is the right default -
// editing a generator's output makes a second source of truth, and the next run
// silently reverts it - but "this file was generated" is not enough to act on.
// The user needs to know WHICH tool, what regenerates it, and what to do
// instead, because the answer differs completely between tools.
//
// Adding one is one file here plus one line in Register: nothing in the scan,
// the proposal or the UI needs to know a new tool exists.
package recognizers

import (
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
)

// Register adds every built-in recognizer to reg, most specific first: a named
// tool answers before the general "this says do-not-edit" fallback.
func Register(reg *plugin.Registry) {
	reg.RegisterRecognizer(Flux{})
	reg.RegisterRecognizer(Helm{})
	reg.RegisterRecognizer(Kustomize{})
	reg.RegisterRecognizer(Kpt{})
	reg.RegisterRecognizer(Generic{})
}

// headOf returns the first few lines of a file, which is where a generator
// stamps its banner. Looking further risks matching a marker phrase that is
// part of a real configuration value.
func headOf(content []byte) string {
	head := content
	if len(head) > 4096 {
		head = head[:4096]
	}
	lines := strings.SplitN(string(head), "\n", 21)
	if len(lines) > 20 {
		lines = lines[:20]
	}
	return strings.ToLower(strings.Join(lines, "\n"))
}

// commentLines returns only the comment lines from the head, so a marker phrase
// buried in a value never counts as a banner.
func commentLines(content []byte) string {
	var b strings.Builder
	for _, ln := range strings.Split(headOf(content), "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "#") || strings.HasPrefix(t, "//") || strings.HasPrefix(t, "<!--") {
			b.WriteString(t)
			b.WriteByte('\n')
		}
	}
	return b.String()
}

// baseOf returns the lower-cased file name.
func baseOf(path string) string {
	p := strings.ToLower(path)
	return p[strings.LastIndex(p, "/")+1:]
}
