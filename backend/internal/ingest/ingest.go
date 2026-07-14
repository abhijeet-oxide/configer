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

// ScanResult is the full result of scanning a repository.
type ScanResult struct {
	Root    string       `json:"root"`
	Files   []FileResult `json:"files"`
	Skipped []string     `json:"skipped"`
	Total   int          `json:"total"` // total candidate parameters found
}

var alwaysSkip = map[string]bool{".git": true, ".configer": true, "node_modules": true}

// Scan walks root, applying ignore rules, and extracts candidate parameters.
func Scan(root string, reg *plugin.Registry, ignore project.Ignore) (ScanResult, error) {
	res := ScanResult{Root: root}

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		if d.IsDir() {
			if alwaysSkip[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if matchesIgnore(rel, ignore.Files) {
			res.Skipped = append(res.Skipped, rel)
			return nil
		}
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil // skip unreadable files
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
