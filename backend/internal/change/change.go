// Package change defines the change-request domain: a set of pending
// parameter edits that travels through the git-native lifecycle
// Draft -> Under Review (PR open) -> Approved -> Published (merged),
// with Rejected as the terminal failure state.
package change

import (
	"strconv"
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
	// ActionUpdateInstance edits an instance's registry metadata (environment,
	// region, version, labels, status). Instance carries the name; New carries
	// the writer.InstancePatch. No files under the instance folder move.
	ActionUpdateInstance Action = "update-instance"
	// ActionEditFile stages a direct file edit from file mode: New carries
	// the full new content, Old the baseline, File the repository path.
	// Applied before value items, so cell edits refine on top.
	ActionEditFile Action = "edit-file"
	// ActionUnmanageParameter takes a parameter out of the catalog, leaving
	// every value where it is. ParamID carries the id; New the parameter's
	// name (so the change reads as words long after the entry is gone).
	//
	// It is a CHANGE like any other: catalogue or configuration, everything
	// travels the same road - draft, review, publish - so nobody has to know
	// which kind of edit takes which path, and nothing reaches the default
	// branch without review.
	ActionUnmanageParameter Action = "unmanage-parameter"
	// ActionAddParameter starts managing a value the repository now carries but
	// the catalog does not know about - typically one a direct file edit just
	// introduced. ParamID carries the id it will get; New the model.Parameter
	// to write into .configer/parameters.yaml; File the file it was found in.
	//
	// It exists because a direct file edit that ADDS settings said only "edited
	// directly": the new values were in the committed bytes, invisible in the
	// grid, and nothing in the review named them. A change that starts managing
	// something is a change like any other, so it travels the same road - draft,
	// review, publish - beside the file edit that introduced it.
	ActionAddParameter Action = "add-parameter"
	// ActionRealignBindings moves catalog entries to follow the values they
	// describe, after a file edit inserted or removed one entry of a repeated
	// structure. File carries the file; New carries a RealignPayload.
	//
	// It exists because these entries are addressed by POSITION. Insert a
	// network in the middle of an XML file and `net-info[3]/net-id` still
	// resolves - to a different network. Nothing errors, nothing is flagged, and
	// the grid quietly starts showing one network's values under another's name.
	// This is the item that keeps the catalog pointing at what it named.
	ActionRealignBindings Action = "realign-bindings"
)

// BindingMove is one parameter's in-file path following its entry.
type BindingMove struct {
	ParamID string `json:"paramId"`
	Name    string `json:"name,omitempty"`
	From    string `json:"from"`
	To      string `json:"to"`
}

// RealignPayload is what a realign-bindings item carries: the parameters whose
// address moved, and the ones whose value the edit took out of the file
// altogether (they would otherwise stay in the catalog bound to nothing).
type RealignPayload struct {
	Moves   []BindingMove `json:"moves,omitempty"`
	Dropped []BindingMove `json:"dropped,omitempty"`
}

// Structural reports whether the action changes the instance topology or the
// catalog rather than a value; structural items apply before value items on
// submit.
func (it Item) Structural() bool {
	a := it.Act()
	return a == ActionAddInstance || a == ActionRemoveInstance || a == ActionUpdateInstance ||
		a == ActionUnmanageParameter || a == ActionAddParameter || a == ActionRealignBindings
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

// Approval is one recorded sign-off on a change request. Separation-of-duties
// and minimum-approval policy read from this list. The approver login is
// authoritative (unlike a free-text comment it cannot be spoofed by the request
// body): the handler records the session identity.
type Approval struct {
	Approver  string    `json:"approver"`
	CreatedAt time.Time `json:"createdAt"`
}

// ChangeRequest is a reviewable unit of configuration change. While in draft
// it accumulates items; on submit it becomes a git branch + commit (+ PR when
// a provider is configured) and advances through the state machine.
type ChangeRequest struct {
	// ID is the store's own key: stable, internal, and allocated the moment a
	// draft exists so the draft can be addressed at all.
	ID int `json:"id"`
	// Number is the CR number people say out loud - "CR-7" - and it is handed
	// out at SUBMIT, not at creation. A draft is not a change request yet: it
	// is one person's uncommitted work, and half of them are discarded. Numbering
	// them burned a number per abandoned draft, so the numbers a team actually
	// reviewed arrived full of holes and "CR-3" was the first change anybody
	// had ever seen. Zero means "not submitted yet".
	Number      int    `json:"number,omitempty"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	// Reference links this CR to an external ticket/CR id (e.g. JIRA-123).
	Reference string `json:"reference,omitempty"`
	// Category classifies the change: hotfix | feature | bugfix |
	// maintenance | security | other.
	Category     string `json:"category,omitempty"`
	Author       string `json:"author"`
	TargetBranch string `json:"targetBranch"`
	Branch       string `json:"branch,omitempty"`
	// BaseSHA is the trunk commit this change branched FROM; CommitSHA is its
	// own commit; MergeSHA is the trunk commit that brought it back in. The
	// three together are what lets a history draw the change's whole arc.
	BaseSHA   string `json:"baseSha,omitempty"`
	CommitSHA string `json:"commitSha,omitempty"`
	MergeSHA  string `json:"mergeSha,omitempty"`
	State     State  `json:"state"`
	Items     []Item `json:"items"`
	PRNumber  int    `json:"prNumber,omitempty"`
	PRURL     string `json:"prUrl,omitempty"`
	// Reviewers are the logins asked to look at this CR. Display and routing
	// only: approval rights stay role-based (approver merges).
	Reviewers []string `json:"reviewers,omitempty"`
	// Comments is the in-app review discussion, oldest first.
	Comments []Comment `json:"comments,omitempty"`
	// Approvals are the recorded sign-offs, oldest first. Distinct by approver;
	// the review gate (separation of duties, minimum approvals) reads from here.
	Approvals []Approval `json:"approvals,omitempty"`
	// Override is set when this change was submitted over the validation gate's
	// objections. It is a FIELD rather than a sentence in the description
	// because an approver must not have to read prose to find out that the data
	// model refused this change and somebody sent it anyway.
	Override  *Override `json:"override,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Override is what the gate objected to, kept with the change.
type Override struct {
	// Summary is the refusal in one sentence, in the reader's terms.
	Summary  string    `json:"summary"`
	Reason   string    `json:"reason,omitempty"`
	By       string    `json:"by,omitempty"`
	At       time.Time `json:"at"`
	Errors   int       `json:"errors"`
	Problems int       `json:"problems"`
	Engine   string    `json:"engine,omitempty"`
	// Objections are the findings themselves, so the review shows what was
	// waved through rather than only how many.
	Objections []Objection `json:"objections,omitempty"`
}

// Objection is one thing the data model refused, as the approver reads it.
type Objection struct {
	Rule     string `json:"rule,omitempty"`
	Name     string `json:"name,omitempty"`
	Instance string `json:"instance,omitempty"`
	File     string `json:"file,omitempty"`
	Path     string `json:"path,omitempty"`
	Message  string `json:"message"`
	Because  string `json:"because,omitempty"`
	Detail   string `json:"detail,omitempty"`
	Schema   string `json:"schema,omitempty"`
}

// Label is how this change request is referred to in words: its CR number once
// it has one, and plainly a draft until then.
func (cr *ChangeRequest) Label() string {
	if cr.Number > 0 {
		return "CR-" + strconv.Itoa(cr.Number)
	}
	return "draft"
}

// HasApprovalFrom reports whether login has already signed off.
func (cr *ChangeRequest) HasApprovalFrom(login string) bool {
	for _, a := range cr.Approvals {
		if strings.EqualFold(a.Approver, login) {
			return true
		}
	}
	return false
}

// AddApproval records a distinct sign-off and returns whether it was newly
// added (a repeat approval by the same login is a no-op).
func (cr *ChangeRequest) AddApproval(login string) bool {
	if login == "" || cr.HasApprovalFrom(login) {
		return false
	}
	cr.Approvals = append(cr.Approvals, Approval{Approver: login, CreatedAt: time.Now().UTC()})
	return true
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
//
// Undoing a file edit also drops the parameters that edit proposed to start
// managing: they exist only because those lines do, and leaving them behind
// would publish a catalog entry bound to a path the file no longer has.
func (cr *ChangeRequest) RemoveItem(paramID, instance string) bool {
	file := ""
	if strings.HasPrefix(paramID, "file:") {
		paramID, file = "", strings.TrimPrefix(paramID, "file:")
	}
	drop := func(i int) bool {
		undone := cr.Items[i]
		cr.Items = append(cr.Items[:i], cr.Items[i+1:]...)
		if undone.Act() == ActionEditFile {
			cr.dropCatalogItems(undone.File)
		}
		return true
	}
	for i := range cr.Items {
		if cr.Items[i].ParamID == paramID && cr.Items[i].Instance == instance && cr.Items[i].File == file {
			return drop(i)
		}
	}
	// An item that names a parameter AND a file - one a file edit proposed to
	// start managing - is still addressed by its parameter. Requiring the file
	// to match too meant the undo beside such a row found nothing and quietly
	// did nothing at all.
	if paramID != "" && file == "" {
		for i := range cr.Items {
			if cr.Items[i].ParamID == paramID && cr.Items[i].Instance == instance {
				return drop(i)
			}
		}
	}
	return false
}

// dropCatalogItems removes the catalog consequences a file edit brought with
// it - the parameters it proposed to start managing, and the realignment that
// keeps the rest pointing at what they name.
func (cr *ChangeRequest) dropCatalogItems(file string) {
	if file == "" {
		return
	}
	kept := cr.Items[:0]
	for _, it := range cr.Items {
		if it.File == file && (it.Act() == ActionAddParameter || it.Act() == ActionRealignBindings) {
			continue
		}
		kept = append(kept, it)
	}
	cr.Items = kept
}

// ReplaceCatalogItems swaps in the complete set of catalog consequences of one
// file's current content. It REPLACES rather than merges because each save is
// the whole truth about that file: a setting an earlier save proposed and this
// one took back out leaves with it, and a realignment is always the difference
// between the committed file and what is on screen now, never a running total.
func (cr *ChangeRequest) ReplaceCatalogItems(file string, items []Item) {
	cr.dropCatalogItems(file)
	cr.Items = append(cr.Items, items...)
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
