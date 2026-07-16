// Package change defines the change-request domain: a set of pending
// parameter edits that travels through the git-native lifecycle
// Draft -> Under Review (PR open) -> Approved -> Published (merged),
// with Rejected as the terminal failure state.
package change

import (
	"strings"
	"time"
)

// State is a change request's lifecycle position.
type State string

const (
	StateDraft       State = "draft"
	StateUnderReview State = "under_review"
	StateApproved    State = "approved"
	StatePublished   State = "published"
	StateRejected    State = "rejected"
)

// Action says what a pending item does to its cell when the CR is applied.
type Action string

const (
	// ActionSet writes New as the instance's override.
	ActionSet Action = "set"
	// ActionReset removes the instance override (and any exclusion) so the
	// cell falls back to the scope chain (base/default).
	ActionReset Action = "reset"
	// ActionExclude tombstones the parameter for this instance: nothing is
	// present in its files, even when a default exists.
	ActionExclude Action = "exclude"
	// ActionAddInstance scaffolds a new instance: a folder following the
	// repository's own convention plus a registry entry. Instance carries the
	// new name; New carries the model.Instance metadata; Old the clone
	// source's name ("" = start empty).
	ActionAddInstance Action = "add-instance"
	// ActionRemoveInstance retires an instance: its folder and registry
	// entry are removed. Instance carries the name.
	ActionRemoveInstance Action = "remove-instance"
	// ActionEditFile stages a direct file edit from file mode: New carries
	// the full new content, Old the baseline, File the repository path.
	// Applied before value items, so cell edits refine on top.
	ActionEditFile Action = "edit-file"
)

// Structural reports whether the action changes the instance topology rather
// than a value; structural items apply before value items on submit.
func (it Item) Structural() bool {
	a := it.Act()
	return a == ActionAddInstance || a == ActionRemoveInstance
}

// Item is one pending change: a (parameter, instance) cell edit, a
// scope-level edit when Scope is set, a structural instance change, or a
// direct file edit when File is set.
type Item struct {
	ParamID  string `json:"paramId"`
	Instance string `json:"instance"`
	// Scope marks a scope-level edit ("global" today): the value applies to
	// every instance that does not override it at a more specific level.
	Scope string `json:"scope,omitempty"`
	// File is the repository path of a direct file edit (ActionEditFile).
	File      string    `json:"file,omitempty"`
	Action    Action    `json:"action,omitempty"` // empty == set
	Old       any       `json:"old"`
	New       any       `json:"new"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Act normalizes the item's action (legacy items default to set).
func (it Item) Act() Action {
	if it.Action == "" {
		return ActionSet
	}
	return it.Action
}

// Comment is one review note on a change request, kept with the CR's
// workflow state (not in Git: discussion is workflow, not configuration).
type Comment struct {
	ID        int       `json:"id"`
	Author    string    `json:"author"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"createdAt"`
}

// ChangeRequest is a reviewable unit of configuration change. While in draft
// it accumulates items; on submit it becomes a git branch + commit (+ PR when
// a provider is configured) and advances through the state machine.
type ChangeRequest struct {
	ID          int    `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	// Reference links this CR to an external ticket/CR id (e.g. JIRA-123).
	Reference string `json:"reference,omitempty"`
	// Category classifies the change: hotfix | feature | bugfix |
	// maintenance | security | other.
	Category     string    `json:"category,omitempty"`
	Author       string    `json:"author"`
	TargetBranch string    `json:"targetBranch"`
	Branch       string    `json:"branch,omitempty"`
	BaseSHA      string    `json:"baseSha,omitempty"`
	CommitSHA    string    `json:"commitSha,omitempty"`
	State        State     `json:"state"`
	Items        []Item    `json:"items"`
	PRNumber     int       `json:"prNumber,omitempty"`
	PRURL        string    `json:"prUrl,omitempty"`
	// Reviewers are the logins asked to look at this CR. Display and routing
	// only: approval rights stay role-based (approver merges).
	Reviewers []string `json:"reviewers,omitempty"`
	// Comments is the in-app review discussion, oldest first.
	Comments  []Comment `json:"comments,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// AddComment appends a review note and returns it. IDs are per-CR and
// monotonic so a comment stays addressable even after others are added.
func (cr *ChangeRequest) AddComment(author, body string) Comment {
	next := 1
	for _, c := range cr.Comments {
		if c.ID >= next {
			next = c.ID + 1
		}
	}
	c := Comment{ID: next, Author: author, Body: body, CreatedAt: time.Now().UTC()}
	cr.Comments = append(cr.Comments, c)
	return c
}

// SetReviewers replaces the reviewer list, trimming blanks and duplicates
// while preserving the order reviewers were named in.
func (cr *ChangeRequest) SetReviewers(logins []string) {
	seen := map[string]bool{}
	out := make([]string, 0, len(logins))
	for _, l := range logins {
		l = strings.TrimSpace(l)
		if l == "" || seen[l] {
			continue
		}
		seen[l] = true
		out = append(out, l)
	}
	cr.Reviewers = out
}

// UpsertItem adds or replaces the pending edit for (paramID, instance, file),
// preserving the original Old value across successive edits of the same cell.
func (cr *ChangeRequest) UpsertItem(it Item) {
	for i := range cr.Items {
		if cr.Items[i].ParamID == it.ParamID && cr.Items[i].Instance == it.Instance && cr.Items[i].File == it.File {
			it.Old = cr.Items[i].Old // first observed value stays the baseline
			cr.Items[i] = it
			return
		}
	}
	cr.Items = append(cr.Items, it)
}

// RemoveItem drops the pending edit for (paramID, instance) and reports
// whether one existed. A direct file edit is addressed by paramID
// "file:<path>" (its ParamID is empty).
func (cr *ChangeRequest) RemoveItem(paramID, instance string) bool {
	file := ""
	if strings.HasPrefix(paramID, "file:") {
		paramID, file = "", strings.TrimPrefix(paramID, "file:")
	}
	for i := range cr.Items {
		if cr.Items[i].ParamID == paramID && cr.Items[i].Instance == instance && cr.Items[i].File == file {
			cr.Items = append(cr.Items[:i], cr.Items[i+1:]...)
			return true
		}
	}
	return false
}

// Instances returns the unique instance names touched by this CR.
func (cr *ChangeRequest) Instances() []string {
	seen := map[string]bool{}
	var out []string
	for _, it := range cr.Items {
		if !seen[it.Instance] {
			seen[it.Instance] = true
			out = append(out, it.Instance)
		}
	}
	return out
}
