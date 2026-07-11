// Package changeset orchestrates the git-native change request lifecycle.
//
// Submit turns a draft's pending items into a real change on Git: an isolated
// worktree on branch configer/cr-<id>, sparse overlay updates, re-rendered
// generated/ artifacts, one commit (machine committer + Changed-by trailer for
// the human author), a push when a remote exists, and a hosted PR when a
// provider is configured. Merge publishes (provider PR merge or local git
// merge); Reject closes.
package changeset

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/crstore"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/render"
	"github.com/abhijeet-oxide/configer/backend/internal/repobackend"
	"github.com/abhijeet-oxide/configer/backend/internal/writer"
)

// Service wires the pieces of the CR pipeline together. The Backend seam
// makes the pipeline identical whether the repository is a local git working
// tree or a remote repository managed through the Git data API (no clone).
type Service struct {
	Backend  repobackend.Backend
	Store    *crstore.Store
	Registry *plugin.Registry
}

func branchName(id int) string { return fmt.Sprintf("configer/cr-%d", id) }

// commitMessage builds the commit with human attribution trailers (§ Git
// identity: the committer is the configured machine identity, the real author
// is recorded in the message).
func commitMessage(cr *change.ChangeRequest) string {
	var b strings.Builder
	b.WriteString(cr.Title)
	b.WriteString("\n\n")
	if cr.Description != "" {
		b.WriteString(cr.Description)
		b.WriteString("\n\n")
	}
	fmt.Fprintf(&b, "%d configuration value(s) changed across %d instance(s).\n\n",
		len(cr.Items), len(cr.Instances()))
	fmt.Fprintf(&b, "Change-Request: #%d\n", cr.ID)
	if cr.Reference != "" {
		fmt.Fprintf(&b, "Reference: %s\n", cr.Reference)
	}
	if cr.Category != "" {
		fmt.Fprintf(&b, "Category: %s\n", cr.Category)
	}
	fmt.Fprintf(&b, "Changed-by: %s\n", cr.Author)
	return b.String()
}

// Submit moves a draft CR to under_review: branch, apply, render, commit,
// push, open PR. Reference and category are optional classification metadata
// recorded as commit trailers and in the PR body.
func (s *Service) Submit(ctx context.Context, id int, title, description, author, reference, category string) (*change.ChangeRequest, error) {
	cr, err := s.Store.Get(id)
	if err != nil {
		return nil, err
	}
	if cr.State != change.StateDraft {
		return nil, fmt.Errorf("change request %d is %s, not draft", id, cr.State)
	}
	if len(cr.Items) == 0 {
		return nil, fmt.Errorf("change request %d has no pending changes", id)
	}
	if title != "" {
		cr.Title = title
	}
	if description != "" {
		cr.Description = description
	}
	if author != "" {
		cr.Author = author
	}
	cr.Reference, cr.Category = reference, category
	if cr.TargetBranch == "" {
		if cr.TargetBranch, err = s.Backend.DefaultBranch(ctx); err != nil {
			return nil, err
		}
	}

	baseSHA, err := s.Backend.HeadSHA(ctx, cr.TargetBranch)
	if err != nil {
		return nil, err
	}
	branch := branchName(cr.ID)

	// Isolated checkout so readers of the primary tree/cache are never
	// disturbed (a git worktree locally, a materialized temp dir remotely).
	ws, err := s.Backend.OpenCR(ctx, branch, cr.TargetBranch)
	if err != nil {
		return nil, err
	}
	defer ws.Close()
	wt := ws.Dir()

	// 1) Apply updates: sparse instance overlays, or the global scope overlay
	//    for scope-level items ("change it for everyone").
	globalTouched := false
	for _, it := range cr.Items {
		var aerr error
		if it.Scope == "global" {
			globalTouched = true
			if it.Act() == change.ActionSet {
				aerr = writer.SetGlobalValue(wt, it.ParamID, it.New)
			} else {
				aerr = writer.ResetGlobalValue(wt, it.ParamID)
			}
		} else {
			switch it.Act() {
			case change.ActionReset:
				aerr = writer.ResetValue(wt, it.Instance, it.ParamID)
			case change.ActionExclude:
				aerr = writer.ExcludeValue(wt, it.Instance, it.ParamID)
			default:
				aerr = writer.SetValue(wt, it.Instance, it.ParamID, it.New)
			}
		}
		if aerr != nil {
			return nil, fmt.Errorf("apply %s/%s: %w", it.ParamID, it.Instance, aerr)
		}
	}

	// 2) Re-render generated/ for every touched instance (deterministic).
	//    A global item touches every instance.
	proj, err := project.Load(wt)
	if err != nil {
		return nil, fmt.Errorf("load project from worktree: %w", err)
	}
	touched := cr.Instances()
	if globalTouched {
		touched = touched[:0]
		for _, inst := range proj.Registry.Instances {
			touched = append(touched, inst.Name)
		}
	}
	for _, inst := range touched {
		if inst == "" {
			continue // scope-level pseudo-instance
		}
		files, err := render.Instance(proj, inst, s.Registry)
		if err != nil {
			return nil, fmt.Errorf("render %s: %w", inst, err)
		}
		for _, f := range files {
			out := filepath.Join(wt, "generated", inst, f.Path)
			if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
				return nil, err
			}
			if err := os.WriteFile(out, []byte(f.Content), 0o644); err != nil {
				return nil, err
			}
		}
	}

	// 3) One commit for the whole CR (worktree commit+push locally, a
	//    Git-data-API partial commit remotely). The branch ref is created.
	sha, err := ws.Commit(ctx, commitMessage(cr))
	if err != nil {
		return nil, err
	}

	// 4) Open a hosted PR when a provider is configured; otherwise the
	//    branch alone is the reviewable artifact (pure-git / no provider).
	prNum, prURL := 0, ""
	if s.Backend.CanPublish() && s.Backend.Provider() != nil {
		pr, err := s.Backend.Provider().Create(ctx, branch, cr.TargetBranch, cr.Title, prBody(cr))
		if err != nil {
			return nil, fmt.Errorf("open pull request: %w", err)
		}
		prNum, prURL = pr.Number, pr.URL
	}

	return s.Store.Update(cr.ID, func(c *change.ChangeRequest) error {
		c.Title, c.Description, c.Author = cr.Title, cr.Description, cr.Author
		c.TargetBranch = cr.TargetBranch
		c.Branch = branch
		c.BaseSHA = baseSHA
		c.CommitSHA = sha
		c.PRNumber = prNum
		c.PRURL = prURL
		c.State = change.StateUnderReview
		return nil
	})
}

func prBody(cr *change.ChangeRequest) string {
	var b strings.Builder
	if cr.Description != "" {
		b.WriteString(cr.Description)
		b.WriteString("\n\n")
	}
	if cr.Reference != "" || cr.Category != "" {
		if cr.Reference != "" {
			fmt.Fprintf(&b, "**Reference:** %s  \n", cr.Reference)
		}
		if cr.Category != "" {
			fmt.Fprintf(&b, "**Category:** %s\n", cr.Category)
		}
		b.WriteString("\n")
	}
	b.WriteString("| Parameter | Instance | Old | New |\n|---|---|---|---|\n")
	for _, it := range cr.Items {
		inst := it.Instance
		if it.Scope == "global" {
			inst = "ALL (global)"
		}
		fmt.Fprintf(&b, "| `%s` | %s | `%v` | `%v` |\n", it.ParamID, inst, it.Old, it.New)
	}
	fmt.Fprintf(&b, "\n_Change request #%d, submitted by %s via Configer._\n", cr.ID, cr.Author)
	return b.String()
}

// Merge publishes an under-review CR: provider PR merge (then sync the local
// tree) or a local --no-ff merge mirroring one.
func (s *Service) Merge(ctx context.Context, id int) (*change.ChangeRequest, error) {
	cr, err := s.Store.Get(id)
	if err != nil {
		return nil, err
	}
	if cr.State != change.StateUnderReview && cr.State != change.StateApproved {
		return nil, fmt.Errorf("change request %d is %s, not mergeable", id, cr.State)
	}

	msg := fmt.Sprintf("Publish change request #%d: %s", cr.ID, cr.Title)
	if s.Backend.Provider() != nil && cr.PRNumber > 0 {
		if err := s.Backend.Provider().Merge(ctx, cr.PRNumber, msg); err != nil {
			return nil, err
		}
		if _, err := s.Backend.Sync(ctx, cr.TargetBranch); err != nil {
			return nil, fmt.Errorf("sync after merge: %w", err)
		}
	} else if err := s.Backend.MergeBranch(ctx, cr.TargetBranch, cr.Branch, msg); err != nil {
		return nil, err
	}
	s.Backend.DeleteBranch(ctx, cr.Branch)

	return s.Store.Update(id, func(c *change.ChangeRequest) error {
		c.State = change.StatePublished
		return nil
	})
}

// Reject closes an under-review CR (closing the PR when one exists) or
// discards a draft entirely.
func (s *Service) Reject(ctx context.Context, id int) (*change.ChangeRequest, error) {
	cr, err := s.Store.Get(id)
	if err != nil {
		return nil, err
	}
	if cr.State == change.StateDraft {
		if err := s.Store.Delete(id); err != nil {
			return nil, err
		}
		cr.State = change.StateRejected
		return cr, nil
	}
	if cr.State != change.StateUnderReview && cr.State != change.StateApproved {
		return nil, fmt.Errorf("change request %d is %s, cannot reject", id, cr.State)
	}
	if s.Backend.Provider() != nil && cr.PRNumber > 0 {
		if err := s.Backend.Provider().Close(ctx, cr.PRNumber); err != nil {
			return nil, err
		}
	}
	s.Backend.DeleteBranch(ctx, cr.Branch)
	return s.Store.Update(id, func(c *change.ChangeRequest) error {
		c.State = change.StateRejected
		return nil
	})
}

// Refresh syncs a CR's state with its hosted PR (merged/closed elsewhere, e.g.
// approved directly on GitHub).
func (s *Service) Refresh(ctx context.Context, id int) (*change.ChangeRequest, error) {
	cr, err := s.Store.Get(id)
	if err != nil {
		return nil, err
	}
	if s.Backend.Provider() == nil || cr.PRNumber == 0 || cr.State != change.StateUnderReview {
		return cr, nil
	}
	pr, err := s.Backend.Provider().Get(ctx, cr.PRNumber)
	if err != nil {
		return cr, nil // provider unreachable: keep local state
	}
	switch {
	case pr.Merged:
		_, _ = s.Backend.Sync(ctx, cr.TargetBranch)
		return s.Store.Update(id, func(c *change.ChangeRequest) error {
			c.State = change.StatePublished
			return nil
		})
	case pr.State == "closed":
		return s.Store.Update(id, func(c *change.ChangeRequest) error {
			c.State = change.StateRejected
			return nil
		})
	}
	return cr, nil
}
