// Package changeset orchestrates the git-native change request lifecycle.
//
// Submit turns a draft's pending items into a real change on Git: an isolated
// worktree on branch configer/cr-<id>, surgical write-back edits into the
// repository's own files, one commit (the session user as git author, the
// machine identity as committer and Co-authored-by credit, plus a Changed-by
// trailer), a push when a remote exists, and a hosted PR when a provider is
// configured. Merge publishes (provider PR merge or local git merge); Reject
// closes.
package changeset

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/crstore"
	"github.com/abhijeet-oxide/configer/backend/internal/layout"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/repobackend"
	"github.com/abhijeet-oxide/configer/backend/internal/writeback"
	"github.com/abhijeet-oxide/configer/backend/internal/writer"
)

// Service wires the pieces of the CR pipeline together. The Backend seam
// makes the pipeline identical whether the repository is a local git working
// tree or a remote repository managed through the Git data API (no clone).
type Service struct {
	Backend repobackend.Backend
	Store   *crstore.Store
	// Bot is the machine identity (committer). When a human author is known,
	// the bot is credited on the commit via a Co-authored-by trailer instead
	// of authoring it.
	Bot repobackend.Author
}

// branchName turns a change request into a readable feature branch. The user
// names the change on submit ("Increase prod memory limit"); we slugify that
// into feature/increase-prod-memory-limit. The id is appended when the slug
// would otherwise be empty or the generic "unnamed", keeping branches unique
// on the remote without ever exposing raw git numbering for a named change.
func branchName(cr *change.ChangeRequest) string {
	slug := slugify(cr.Title)
	if slug == "" || slug == "unnamed" || slug == "draft-changes" {
		return fmt.Sprintf("feature/unnamed-cr-%d", cr.ID)
	}
	return "feature/" + slug
}

// slugify lowercases a title into a git-ref-safe slug (kept local so the
// changeset package has no dependency on the api layer).
func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevDash = false
		default:
			if !prevDash {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

// commitMessage builds the commit message with attribution trailers (§ Git
// identity: the human user is the git author, the machine identity is the
// committer and is credited as co-author of the change it wrote out).
func commitMessage(cr *change.ChangeRequest, ident, bot repobackend.Author) string {
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
	if !ident.Empty() && !bot.Empty() {
		fmt.Fprintf(&b, "Co-authored-by: %s\n", bot.Sig())
	}
	return b.String()
}

// Submit moves a draft CR to under_review: branch, apply, render, commit,
// push, open PR. Reference and category are optional classification metadata
// recorded as commit trailers and in the PR body.
func (s *Service) Submit(ctx context.Context, id int, title, description, author, reference, category string, ident repobackend.Author) (*change.ChangeRequest, error) {
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
	branch := branchName(cr)

	// Isolated checkout so readers of the primary tree/cache are never
	// disturbed (a git worktree locally, a materialized temp dir remotely).
	ws, err := s.Backend.OpenCR(ctx, branch, cr.TargetBranch)
	if err != nil {
		return nil, err
	}
	defer ws.Close()
	wt := ws.Dir()

	// 1) Apply every item by editing the repository's OWN files in the
	//    isolated worktree - the write-back-native model. Each edit is
	//    surgical (comments, order and unmanaged content preserved), exactly
	//    the diff a careful engineer would have produced by hand. Structural
	//    items (add/remove instance) go first so value edits for a brand-new
	//    instance land in its freshly scaffolded folder.
	proj, err := project.Load(wt)
	if err != nil {
		return nil, fmt.Errorf("load project from worktree: %w", err)
	}
	structuralApplied := false
	for _, it := range cr.Items {
		if !it.Structural() {
			continue
		}
		if err := applyStructural(wt, proj, it); err != nil {
			return nil, fmt.Errorf("apply %s %s: %w", it.Act(), it.Instance, err)
		}
		structuralApplied = true
	}
	if structuralApplied {
		if proj, err = project.Load(wt); err != nil {
			return nil, fmt.Errorf("reload project from worktree: %w", err)
		}
	}
	// Direct file edits (file mode) go next: full-content writes that value
	// items then refine on top.
	for _, it := range cr.Items {
		if it.Act() != change.ActionEditFile {
			continue
		}
		content, _ := it.New.(string)
		full := filepath.Join(wt, filepath.FromSlash(it.File))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			return nil, fmt.Errorf("apply file edit %s: %w", it.File, err)
		}
	}
	for _, it := range cr.Items {
		if it.Structural() || it.Act() == change.ActionEditFile {
			continue
		}
		if err := applyItem(wt, proj, it); err != nil {
			return nil, fmt.Errorf("apply %s/%s: %w", it.ParamID, it.Instance, err)
		}
	}

	// 2) One commit for the whole CR (worktree commit+push locally, a
	//    Git-data-API partial commit remotely). The branch ref is created.
	//    The human behind the session is the git author; the machine identity
	//    commits and is credited as co-author.
	sha, err := ws.Commit(ctx, commitMessage(cr, ident, s.Bot), ident)
	if err != nil {
		return nil, err
	}

	// 3) Open a hosted PR when a provider is configured; otherwise the
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

// applyItem writes one draft item into the repository files inside root.
//
//   - A global-scope item edits the parameter's base-layer (shared) bindings:
//     one edit, every instance follows.
//   - An instance item edits the parameter's instance-layer bindings expanded
//     for that instance, fanning out to every mapped file (a deduplicated
//     parameter lives in several).
//   - "reset" and "exclude" remove the key from the instance's files: the
//     value falls back to whatever the base layer supplies, or becomes truly
//     absent - exactly what deleting the line by hand would mean.
func applyItem(root string, proj *project.Project, it change.Item) error {
	param, ok := proj.ParamByID(it.ParamID)
	if !ok {
		return fmt.Errorf("parameter %q not found", it.ParamID)
	}

	if it.Scope == "global" {
		bindings := param.BindingsOn(model.LayerBase, model.Instance{})
		if len(bindings) == 0 {
			return fmt.Errorf("parameter %q has no shared (base-layer) binding for a global edit", it.ParamID)
		}
		for _, b := range bindings {
			var err error
			if it.Act() == change.ActionSet {
				err = writeback.SetValue(root, b.File, b.Format, b.Path, param.Type, it.New)
			} else {
				err = writeback.RemoveValue(root, b.File, b.Format, b.Path, param.Type)
			}
			if err != nil {
				return err
			}
		}
		return nil
	}

	inst, ok := proj.InstanceByName(it.Instance)
	if !ok {
		return fmt.Errorf("instance %q not found", it.Instance)
	}
	bindings := param.BindingsOn(model.LayerInstance, inst)
	if len(bindings) == 0 {
		return fmt.Errorf("parameter %q has no instance-layer binding; edit it globally", it.ParamID)
	}
	for _, b := range bindings {
		var err error
		switch it.Act() {
		case change.ActionReset, change.ActionExclude:
			err = writeback.RemoveValue(root, b.File, b.Format, b.Path, param.Type)
		default:
			err = writeback.SetValue(root, b.File, b.Format, b.Path, param.Type, it.New)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// applyStructural performs an instance-topology item in the worktree: a new
// instance is scaffolded by the layout adapter (following the repository's
// own convention) or an existing one is retired (folder + registry entry) -
// exactly what a careful engineer would do by hand.
func applyStructural(root string, proj *project.Project, it change.Item) error {
	switch it.Act() {
	case change.ActionAddInstance:
		var meta model.Instance
		if err := decodeInto(it.New, &meta); err != nil {
			return fmt.Errorf("decode instance metadata: %w", err)
		}
		meta.Name = it.Instance
		cloneFrom, _ := it.Old.(string)
		if cloneFrom != "" {
			from, ok := proj.InstanceByName(cloneFrom)
			if !ok {
				return fmt.Errorf("clone source %q not found", cloneFrom)
			}
			scaffolded, err := layout.ForKind(proj.App.Layout).Scaffold(root, from, it.Instance)
			if err != nil {
				return err
			}
			meta.Folder = scaffolded.Folder
			if meta.SoftwareVersion == "" {
				meta.SoftwareVersion = from.SoftwareVersion
			}
		}
		return writer.AddInstance(root, meta)
	case change.ActionRemoveInstance:
		return writer.DeleteInstance(root, it.Instance)
	case change.ActionUpdateInstance:
		var patch writer.InstancePatch
		if err := decodeInto(it.New, &patch); err != nil {
			return fmt.Errorf("decode instance patch: %w", err)
		}
		_, err := writer.UpdateInstance(root, it.Instance, patch)
		return err
	}
	return fmt.Errorf("unknown structural action %q", it.Act())
}

// decodeInto round-trips a JSON-shaped any into a typed struct.
func decodeInto(v any, out any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
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
	b.WriteString("| Change | Instance | Old | New |\n|---|---|---|---|\n")
	for _, it := range cr.Items {
		inst := it.Instance
		if it.Scope == "global" {
			inst = "ALL (global)"
		}
		switch it.Act() {
		case change.ActionAddInstance:
			src := "empty"
			if from, _ := it.Old.(string); from != "" {
				src = "clone of " + from
			}
			fmt.Fprintf(&b, "| add instance | %s | - | %s |\n", inst, src)
		case change.ActionRemoveInstance:
			fmt.Fprintf(&b, "| remove instance | %s | - | - |\n", inst)
		case change.ActionEditFile:
			fmt.Fprintf(&b, "| edit file `%s` | %s | - | - |\n", it.File, inst)
		default:
			fmt.Fprintf(&b, "| `%s` | %s | `%v` | `%v` |\n", it.ParamID, inst, it.Old, it.New)
		}
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
