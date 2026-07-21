package changeset

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// FilePreview is one file a change request will rewrite, with its exact content
// before and after the surgical edit so the UI can render a real diff (the same
// bytes that will be committed, not a value-level summary).
type FilePreview struct {
	File      string `json:"file"`
	Status    string `json:"status"` // modified | added | removed
	Before    string `json:"before"`
	After     string `json:"after"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

// PreviewResult is the byte-level plan for a change request: the files it
// rewrites plus one-line summaries for structural instance changes (which add
// or remove whole folders rather than editing a single file).
type PreviewResult struct {
	Files      []FilePreview `json:"files"`
	Structural []string      `json:"structural"`
}

// Preview builds the change request's edits in a throwaway checkout of the base
// branch (no branch created, nothing committed or pushed) and reports the exact
// per-file before/after content. It runs the same apply pipeline Submit uses,
// so the preview is faithful to what a submit would write.
func (s *Service) Preview(ctx context.Context, id int) (*PreviewResult, error) {
	cr, err := s.Store.Get(id)
	if err != nil {
		return nil, err
	}
	if len(cr.Items) == 0 {
		return &PreviewResult{}, nil
	}

	base := cr.TargetBranch
	if base == "" {
		if base, err = s.Backend.DefaultBranch(ctx); err != nil {
			return nil, err
		}
	}

	// A detached checkout: read the base, edit in place, throw it away. No CR
	// branch is created, so a later Submit is free to create the real one.
	dir, err := os.MkdirTemp("", "configer-preview-")
	if err != nil {
		return nil, err
	}
	_ = os.RemoveAll(dir) // MaterializeRef wants the path not to exist yet.
	cleanup, err := s.Backend.MaterializeRef(ctx, base, dir)
	if err != nil {
		return nil, err
	}
	defer func() {
		cleanup()
		_ = os.RemoveAll(dir)
	}()

	proj, err := project.Load(dir)
	if err != nil {
		return nil, fmt.Errorf("load project for preview: %w", err)
	}

	// Snapshot every file the value/file edits will touch before applying, so
	// we can diff old against new. Structural items become summary lines.
	targets := plannedFiles(proj, cr)
	before := make(map[string]string, len(targets))
	for _, f := range targets {
		before[f] = readFileOrEmpty(dir, f)
	}
	var structural []string
	for _, it := range cr.Items {
		if it.Structural() {
			structural = append(structural, structuralSummary(it))
		}
	}

	if err := applyDraft(dir, cr); err != nil {
		return nil, err
	}

	var files []FilePreview
	for _, f := range targets {
		after := readFileOrEmpty(dir, f)
		b := before[f]
		if b == after {
			continue // an edit that resolved to a no-op
		}
		status := "modified"
		switch {
		case b == "":
			status = "added"
		case after == "":
			status = "removed"
		}
		adds, dels := lineDelta(b, after)
		files = append(files, FilePreview{
			File: f, Status: status, Before: b, After: after,
			Additions: adds, Deletions: dels,
		})
	}
	return &PreviewResult{Files: files, Structural: structural}, nil
}

// plannedFiles returns, in a stable order, the repository-relative files the
// change request's value and file edits will touch (bindings expanded per
// instance). Structural items are excluded; they are summarized separately.
func plannedFiles(proj *project.Project, cr *change.ChangeRequest) []string {
	seen := map[string]bool{}
	var out []string
	add := func(f string) {
		if f != "" && !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	for _, it := range cr.Items {
		switch {
		case it.Act() == change.ActionEditFile:
			add(it.File)
		case it.Structural():
			// summarized, not byte-diffed
		default:
			param, ok := proj.ParamByID(it.ParamID)
			if !ok {
				continue
			}
			if it.Scope == "global" {
				for _, b := range param.BindingsOn(model.LayerBase, model.Instance{}) {
					add(b.File)
				}
				continue
			}
			inst, ok := proj.InstanceByName(it.Instance)
			if !ok {
				continue
			}
			for _, b := range param.BindingsOn(model.LayerInstance, inst) {
				add(b.File)
			}
		}
	}
	return out
}

// structuralSummary renders a one-line description of an instance-topology item.
func structuralSummary(it change.Item) string {
	switch it.Act() {
	case change.ActionAddInstance:
		if from, _ := it.Old.(string); from != "" {
			return "add instance " + it.Instance + " (clone of " + from + ")"
		}
		return "add instance " + it.Instance
	case change.ActionRemoveInstance:
		return "remove instance " + it.Instance
	case change.ActionUpdateInstance:
		return "update instance " + it.Instance
	}
	return string(it.Act()) + " " + it.Instance
}

func readFileOrEmpty(dir, rel string) string {
	b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
	if err != nil {
		return ""
	}
	return string(b)
}

// lineDelta counts added and removed lines between two texts using the length
// of their longest common subsequence of lines - the same arithmetic git uses
// for its +/- summary. It drives a badge, not the rendered diff, so an
// exact-but-simple line metric is all that is needed.
func lineDelta(before, after string) (adds, dels int) {
	a := splitLines(before)
	b := splitLines(after)
	common := lcsLen(a, b)
	return len(b) - common, len(a) - common
}

func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	s = strings.TrimSuffix(s, "\n")
	return strings.Split(s, "\n")
}

// lcsLen is the length of the longest common subsequence of two line slices.
func lcsLen(a, b []string) int {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	prev := make([]int, len(b)+1)
	curr := make([]int, len(b)+1)
	for i := 1; i <= len(a); i++ {
		for j := 1; j <= len(b); j++ {
			if a[i-1] == b[j-1] {
				curr[j] = prev[j-1] + 1
			} else if prev[j] >= curr[j-1] {
				curr[j] = prev[j]
			} else {
				curr[j] = curr[j-1]
			}
		}
		prev, curr = curr, prev
	}
	return prev[len(b)]
}
