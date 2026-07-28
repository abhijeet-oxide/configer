// Package ingest scans a repository working tree, detects configuration files
// via the registered parser plugins, and extracts candidate parameters. Files
// matching ignore globs (or living under .configer or .git) are skipped.
package ingest

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// FileResult is the extraction outcome for one source file.
type FileResult struct {
	File       string             `json:"file"`
	Format     string             `json:"format"`
	Parser     string             `json:"parser"`
	Candidates []plugin.Candidate `json:"candidates"`
	Error      string             `json:"error,omitempty"`
}

// SkipReason is why one file was left out of the scan. It is a stable key so
// the UI can phrase it, and it exists because a bare list of paths answers the
// wrong question: someone looking at a repository Configer found nothing in
// needs to know WHY their files were passed over, and "skipped" alone reads as
// a fault rather than a decision.
type SkipReason string

const (
	// SkipGenerated: the file's own header says it is generator output.
	SkipGenerated SkipReason = "generated"
	// SkipIgnored: an ignore rule in .configer/ignore.yaml matched it.
	SkipIgnored SkipReason = "ignored"
	// SkipStructural: the file describes structure rather than settings - a
	// kustomization, a Kptfile, a chart's plumbing, a schema. Discovery decides
	// this, not the scan, but it is reported the same way: a file that vanishes
	// with no explanation is the same dead end whichever stage dropped it.
	SkipStructural SkipReason = "structural"
)

// SkippedFile is one file the scan left out, and why.
type SkippedFile struct {
	File   string     `json:"file"`
	Reason SkipReason `json:"reason"`
	// Origin is what produced the file, when a recognizer knew. It carries the
	// specifics the user needs to decide whether to manage it anyway: which
	// tool, what regenerates it, and where the same change would survive.
	Origin *plugin.Origin `json:"origin,omitempty"`
}

// ScanResult is the full result of scanning a repository.
type ScanResult struct {
	Root    string        `json:"root"`
	Files   []FileResult  `json:"files"`
	Skipped []SkippedFile `json:"skipped"`
	Total   int           `json:"total"` // total candidate parameters found
}

var alwaysSkip = map[string]bool{".git": true, ".configer": true, "node_modules": true}

// Options steer one scan.
type Options struct {
	// Manage lists repo-relative files to read even though they would normally
	// be passed over. It is the user overriding a default that is right in
	// general and wrong for their repository - their repository, their call -
	// and it is a list rather than a flag so the decision stays per file.
	Manage []string
}

// Scan walks root, applying ignore rules, and extracts candidate parameters.
func Scan(root string, reg *plugin.Registry, ignore project.Ignore) (ScanResult, error) {
	return ScanWith(root, reg, ignore, Options{})
}

// ScanWith is Scan with per-file overrides.
func ScanWith(root string, reg *plugin.Registry, ignore project.Ignore, opts Options) (ScanResult, error) {
	res := ScanResult{Root: root}
	managed := map[string]bool{}
	for _, f := range opts.Manage {
		managed[f] = true
	}

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		// Normalize to forward slashes so downstream matching (instance-folder
		// prefixes, bindings, ignore globs) is identical on Windows and Unix.
		// Without this, a Windows "instances\prod\values.yaml" never matches an
		// "instances/prod/" folder prefix and every file wrongly falls to the
		// shared layer (0 instances detected).
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if alwaysSkip[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if matchesIgnore(rel, ignore.Files) && !managed[rel] {
			res.Skipped = append(res.Skipped, SkippedFile{File: rel, Reason: SkipIgnored})
			return nil
		}
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil // skip unreadable files
		}
		// A file a generator emitted (a committed `helm template` render, the
		// manifests `flux bootstrap` writes) is a copy of config that lives
		// elsewhere: managing it creates a second source of truth that the next
		// run of the generator reverts. Which generator matters - the answer to
		// "so what do I do instead" is different for each - so this asks the
		// recognizer plugins rather than matching phrases here.
		if origin, ok := reg.OriginOf(rel, content); ok && !managed[rel] {
			res.Skipped = append(res.Skipped, SkippedFile{File: rel, Reason: SkipGenerated, Origin: &origin})
			return nil
		}
		parser, perr := reg.ParserFor(rel, content)
		if perr != nil {
			return nil // not a recognized config file
		}
		fr := FileResult{File: rel, Parser: parser.Manifest().ID}
		cands, exErr := parser.Extract(rel, content)
		if exErr != nil {
			fr.Error = exErr.Error()
		} else {
			// drop ignored parameters (by path)
			for _, c := range cands {
				if matchesIgnore(c.Path, ignore.Parameters) || contains(ignore.Parameters, c.Path) {
					continue
				}
				fr.Candidates = append(fr.Candidates, c)
				fr.Format = c.Format
			}
			res.Total += len(fr.Candidates)
		}
		res.Files = append(res.Files, fr)
		return nil
	})
	return res, err
}

func matchesIgnore(rel string, patterns []string) bool {
	rel = filepath.ToSlash(rel)
	for _, p := range patterns {
		if ok, _ := filepath.Match(p, rel); ok {
			return true
		}
		// support suffix globs like "**/*.tmp"
		if strings.HasPrefix(p, "**/") {
			if ok, _ := filepath.Match(strings.TrimPrefix(p, "**/"), filepath.Base(rel)); ok {
				return true
			}
		}
	}
	return false
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}
