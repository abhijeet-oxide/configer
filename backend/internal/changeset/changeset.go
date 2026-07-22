// Package changeset orchestrates the git-native change request lifecycle.
//
// Submit turns a draft's pending items into a real change on Git: an isolated
// worktree on branch feature/<slug> (named after the change), surgical write-back edits into the
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
	"github.com/abhijeet-oxide/configer/backend/internal/pathedit"
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
	// Policy is the review gate. Its zero value is the single-user tool: any
	// approver may approve and an under-review change may be published directly.
	Policy Policy
}

// Policy governs the review gate. The zero value is deliberately permissive so
// the single-user tool can submit-and-publish in one step; a shared deployment
// tightens it (see the api layer, which turns these on when login is enabled).
type Policy struct {
	// RequireApproval makes Merge refuse an under-review change: it must carry a
	// recorded approval (be in the Approved state) before it can be published.
	RequireApproval bool
	// RequireSeparateApprover enforces separation of duties: the approver must
	// not be the change's own author. A single identity cannot self-approve.
	RequireSeparateApprover bool
	// MinApprovals is how many distinct approvers must sign off before a change
	// becomes Approved. Zero or one means a single approval suffices.
	MinApprovals int
}

// approvalsNeeded is the number of distinct sign-offs required to reach the
// Approved state (at least one).
func (p Policy) approvalsNeeded() int {
	if p.MinApprovals < 1 {
		return 1
	}
	return p.MinApprovals
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
		return nil, conflictf("change request %d is %s, not draft", id, cr.State)
	}
	if len(cr.Items) == 0 {
		return nil, conflictf("change request %d has no pending changes", id)
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
	//    the diff a careful engineer would have produced by hand.
	if err := applyDraft(wt, cr); err != nil {
		return nil, err
	}

	// 2) One commit for the whole CR (worktree commit+push locally, a
	//    Git-data-API partial commit remotely). The branch ref is created.
	//    The human behind the session is the git author; the machine identity
	//    commits and is credited as co-author.
	sha, err := ws.Commit(ctx, commitMessage(cr, ident, s.Bot), ident)
	if err != nil {
		// With a remote, Commit also pushes; a failure here is a downstream
		// (network/push-rejected) problem, not the client's fault.
		if s.Backend.CanPublish() {
			return nil, upstream("save and push the change", err)
		}
		return nil, err
	}

	// 3) Open a hosted PR when a provider is configured; otherwise the
	//    branch alone is the reviewable artifact (pure-git / no provider).
	prNum, prURL := 0, ""
	if s.Backend.CanPublish() && s.Backend.Provider() != nil {
		pr, err := s.Backend.Provider().Create(ctx, branch, cr.TargetBranch, cr.Title, prBody(cr))
		if err != nil {
			return nil, upstream("open pull request", err)
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

// applyDraft applies every item of a change request into the worktree wt
// (already checked out at the base), in the order Submit commits them:
// structural instance changes first (so value edits for a brand-new instance
// land in its freshly scaffolded folder), then whole-file edits, then value
// edits refined on top. Both Submit and Preview go through here so what a
// reviewer previews is byte-for-byte what gets committed.
func applyDraft(wt string, cr *change.ChangeRequest) error {
	proj, err := project.Load(wt)
	if err != nil {
		return fmt.Errorf("load project from worktree: %w", err)
	}
	structuralApplied := false
	for _, it := range cr.Items {
		if !it.Structural() {
			continue
		}
		if err := applyStructural(wt, proj, it); err != nil {
			return fmt.Errorf("apply %s %s: %w", it.Act(), it.Instance, err)
		}
		structuralApplied = true
	}
	if structuralApplied {
		if proj, err = project.Load(wt); err != nil {
			return fmt.Errorf("reload project from worktree: %w", err)
		}
	}
	for _, it := range cr.Items {
		if it.Act() != change.ActionEditFile {
			continue
		}
		content, _ := it.New.(string)
		full := filepath.Join(wt, filepath.FromSlash(it.File))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			return fmt.Errorf("apply file edit %s: %w", it.File, err)
		}
	}
	for _, it := range cr.Items {
		if it.Structural() || it.Act() == change.ActionEditFile {
			continue
		}
		if err := applyItem(wt, proj, it); err != nil {
			return fmt.Errorf("apply %s/%s: %w", it.ParamID, it.Instance, err)
		}
	}
	return nil
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
				if err = ensureNotStale(root, b, param.Type, it); err != nil {
					return err
				}
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
			if err = ensureNotStale(root, b, param.Type, it); err != nil {
				return err
			}
			err = writeback.SetValue(root, b.File, b.Format, b.Path, param.Type, it.New)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// ensureNotStale guards against silently clobbering an external change: if the
// value living at the binding no longer matches what the user saw when they
// staged the edit (it.Old), someone changed it on Git in between, and applying
// our set would overwrite their change with a clean-looking diff. We refuse with
// a conflict so the drift surfaces for review instead of vanishing. A legacy
// item with no captured baseline, or a target that does not yet exist, is not a
// clobber and passes through.
func ensureNotStale(root string, b model.Binding, ptype model.ParamType, it change.Item) error {
	if it.Old == nil {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(root, b.File))
	if err != nil {
		return nil // absent/unreadable: SetValue creates it, nothing to overwrite
	}
	live, ok, err := pathedit.Get(data, b.Format, b.Path)
	if err != nil || !ok {
		return nil // not present to clobber
	}
	if !sameScalar(live, it.Old) {
		return conflictf(
			"cannot apply %q: %s now holds %v, but this edit was staged against %v - someone changed it on Git in the meantime; reload and re-stage",
			it.ParamID, b.File, live, it.Old)
	}
	return nil
}

// sameScalar compares two scalar values tolerantly across the type skew of
// YAML/JSON decoding (the integer 8080 vs the string "8080"): equal rendered
// forms count as equal, so a faithful round-trip never reads as drift.
func sameScalar(a, b any) bool {
	return fmt.Sprintf("%v", a) == fmt.Sprintf("%v", b)
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
			if meta.VersionName == "" {
				meta.VersionName = from.VersionName
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
		return nil, conflictf("change request %d is %s, not mergeable", id, cr.State)
	}
	// Approval-before-publish: a shared deployment refuses to publish a change
	// that no separate approver has signed off on.
	if s.Policy.RequireApproval && cr.State != change.StateApproved {
		return nil, conflictf("change request %d must be approved before it can be published", id)
	}

	msg := fmt.Sprintf("Publish change request #%d: %s", cr.ID, cr.Title)
	if s.Backend.Provider() != nil && cr.PRNumber > 0 {
		if err := s.Backend.Provider().Merge(ctx, cr.PRNumber, msg); err != nil {
			return nil, upstream("publish the change", err)
		}
		if _, err := s.Backend.Sync(ctx, cr.TargetBranch); err != nil {
			return nil, upstream("sync after publishing", err)
		}
	} else if err := s.Backend.MergeBranch(ctx, cr.TargetBranch, cr.Branch, msg); err != nil {
		return nil, upstream("publish the change", err)
	}
	s.Backend.DeleteBranch(ctx, cr.Branch)

	return s.Store.Update(id, func(c *change.ChangeRequest) error {
		c.State = change.StatePublished
		return nil
	})
}

// Approve records an approver's sign-off on an under-review change request,
// advancing it to Approved (once enough distinct approvers have signed off)
// without publishing. Publishing (Merge) then needs only one more click, and
// the two-step approve-then-publish separation gives a clear "approved but not
// yet live" state. The approver login is recorded as a structured approval and
// a review comment for the audit trail.
//
// Two governance gates apply when policy enables them: separation of duties
// (an author cannot approve their own change) and a minimum number of distinct
// approvals before the change is considered approved.
func (s *Service) Approve(ctx context.Context, id int, approver string) (*change.ChangeRequest, error) {
	cr, err := s.Store.Get(id)
	if err != nil {
		return nil, err
	}
	// A change stays under review until enough approvals accumulate, so multiple
	// approvers sign off here; once it reaches Approved the gate is closed.
	if cr.State != change.StateUnderReview {
		return nil, conflictf("change request %d is %s, not awaiting review", id, cr.State)
	}
	if s.Policy.RequireSeparateApprover && approver != "" && strings.EqualFold(approver, cr.Author) {
		return nil, conflictf("you cannot approve your own change request; a separate approver must sign off")
	}
	if approver != "" && cr.HasApprovalFrom(approver) {
		return nil, conflictf("you have already approved change request %d", id)
	}
	needed := s.Policy.approvalsNeeded()
	return s.Store.Update(id, func(c *change.ChangeRequest) error {
		if approver != "" {
			c.AddApproval(approver)
			c.AddComment(approver, "Approved this change.")
		}
		// Advance to Approved once enough distinct approvers have signed off. In
		// single-user mode (no identity) a single approve suffices.
		if approver == "" || len(c.Approvals) >= needed {
			c.State = change.StateApproved
		}
		return nil
	})
}

// Reject closes an under-review CR (closing the PR when one exists) or
// discards a draft entirely. The rejecter and their reason (when given) are
// recorded as a review comment so "why was this turned down" survives.
func (s *Service) Reject(ctx context.Context, id int, rejecter, reason string) (*change.ChangeRequest, error) {
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
		return nil, conflictf("change request %d is %s, cannot reject", id, cr.State)
	}
	if s.Backend.Provider() != nil && cr.PRNumber > 0 {
		if err := s.Backend.Provider().Close(ctx, cr.PRNumber); err != nil {
			return nil, upstream("close the pull request", err)
		}
	}
	s.Backend.DeleteBranch(ctx, cr.Branch)
	return s.Store.Update(id, func(c *change.ChangeRequest) error {
		if rejecter != "" {
			body := "Rejected this change."
			if reason != "" {
				body = "Rejected this change: " + reason
			}
			c.AddComment(rejecter, body)
		}
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
