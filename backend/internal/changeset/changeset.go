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
	"github.com/abhijeet-oxide/configer/backend/internal/gitengine"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/provider"
	"github.com/abhijeet-oxide/configer/backend/internal/render"
	"github.com/abhijeet-oxide/configer/backend/internal/writer"
)

// Service wires the pieces of the CR pipeline together.
type Service struct {
	Repo     *gitengine.Repo
	Store    *crstore.Store
	Registry *plugin.Registry
	Provider provider.Provider // nil => pure-git fallback
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
	fmt.Fprintf(&b, "Changed-by: %s\n", cr.Author)
	return b.String()
}

// Submit moves a draft CR to under_review: branch, apply, render, commit,
// push, open PR.
func (s *Service) Submit(ctx context.Context, id int, title, description, author string) (*change.ChangeRequest, error) {
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
	if cr.TargetBranch == "" {
		if cr.TargetBranch, err = s.Repo.CurrentBranch(); err != nil {
			return nil, err
		}
	}

	baseSHA, err := s.Repo.HeadSHA(cr.TargetBranch)
	if err != nil {
		return nil, err
	}
	branch := branchName(cr.ID)

	// Isolated worktree so readers of the primary tree are never disturbed.
	wt, err := os.MkdirTemp("", fmt.Sprintf("configer-cr-%d-", cr.ID))
	if err != nil {
		return nil, err
	}
	defer func() {
		s.Repo.RemoveWorktree(wt)
		_ = os.RemoveAll(wt)
	}()
	if err := s.Repo.AddWorktree(wt, branch, cr.TargetBranch); err != nil {
		return nil, err
	}

	// 1) Apply sparse overlay updates (set / reset-to-inherited / exclude).
	for _, it := range cr.Items {
		var aerr error
		switch it.Act() {
		case change.ActionReset:
			aerr = writer.ResetValue(wt, it.Instance, it.ParamID)
		case change.ActionExclude:
			aerr = writer.ExcludeValue(wt, it.Instance, it.ParamID)
		default:
			aerr = writer.SetValue(wt, it.Instance, it.ParamID, it.New)
		}
		if aerr != nil {
			return nil, fmt.Errorf("apply %s/%s: %w", it.ParamID, it.Instance, aerr)
		}
	}

	// 2) Re-render generated/ for every touched instance (deterministic).
	proj, err := project.Load(wt)
	if err != nil {
		return nil, fmt.Errorf("load project from worktree: %w", err)
	}
	for _, inst := range cr.Instances() {
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

	// 3) One commit for the whole CR.
	sha, err := s.Repo.CommitAll(wt, commitMessage(cr))
	if err != nil {
		return nil, err
	}

	// 4) Push + open PR when possible; otherwise stay pure-git local.
	prNum, prURL := 0, ""
	if s.Repo.HasRemote() {
		if err := s.Repo.Push(branch); err != nil {
			return nil, fmt.Errorf("push %s: %w", branch, err)
		}
		if s.Provider != nil {
			pr, err := s.Provider.Create(ctx, branch, cr.TargetBranch, cr.Title, prBody(cr))
			if err != nil {
				return nil, fmt.Errorf("open pull request: %w", err)
			}
			prNum, prURL = pr.Number, pr.URL
		}
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
	b.WriteString("| Parameter | Instance | Old | New |\n|---|---|---|---|\n")
	for _, it := range cr.Items {
		fmt.Fprintf(&b, "| `%s` | %s | `%v` | `%v` |\n", it.ParamID, it.Instance, it.Old, it.New)
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
	if s.Provider != nil && cr.PRNumber > 0 {
		if err := s.Provider.Merge(ctx, cr.PRNumber, msg); err != nil {
			return nil, err
		}
		if err := s.Repo.Pull(cr.TargetBranch); err != nil {
			return nil, fmt.Errorf("sync after merge: %w", err)
		}
	} else {
		cur, err := s.Repo.CurrentBranch()
		if err != nil {
			return nil, err
		}
		if cur != cr.TargetBranch {
			return nil, fmt.Errorf("primary tree is on %s, cannot locally merge into %s", cur, cr.TargetBranch)
		}
		if err := s.Repo.MergeBranch(cr.Branch, msg); err != nil {
			return nil, err
		}
		if s.Repo.HasRemote() {
			if err := s.Repo.Push(cr.TargetBranch); err != nil {
				return nil, fmt.Errorf("push %s: %w", cr.TargetBranch, err)
			}
		}
	}
	s.Repo.DeleteBranch(cr.Branch)

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
	if s.Provider != nil && cr.PRNumber > 0 {
		if err := s.Provider.Close(ctx, cr.PRNumber); err != nil {
			return nil, err
		}
	}
	s.Repo.DeleteBranch(cr.Branch)
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
	if s.Provider == nil || cr.PRNumber == 0 || cr.State != change.StateUnderReview {
		return cr, nil
	}
	pr, err := s.Provider.Get(ctx, cr.PRNumber)
	if err != nil {
		return cr, nil // provider unreachable: keep local state
	}
	switch {
	case pr.Merged:
		_ = s.Repo.Pull(cr.TargetBranch)
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
