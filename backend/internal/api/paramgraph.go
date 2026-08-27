package api

// A parameter's LIFE, not just its log.
//
// The commit log answers "what does the trunk say this value has been". It
// cannot answer the questions people actually bring to a value that surprised
// them: who proposed changing it, was it turned down, why, and did the change
// that finally landed carry the same number as the one that was refused. Those
// facts live in the change requests, not in git - a rejected change never
// reaches the trunk, so by definition no log will ever mention it.
//
// So a parameter's history is TWO things laid over one another: the trunk, and
// the change requests that touched this parameter, each one attached to the
// commit it forked from and (when it landed) the commit that brought it back.
// That is the same story the application-level Change Flow tells, narrowed to
// one value - which is what makes it readable as blame: every version of this
// value, and the reviewed decision that put it there or kept it out.

import (
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
)

// paramEdit is what one change request proposed to do to this parameter, in
// the terms the grid uses: a cell (instance or global scope) moving from one
// value to another.
type paramEdit struct {
	Instance string        `json:"instance,omitempty"`
	Scope    string        `json:"scope,omitempty"`
	Action   change.Action `json:"action"`
	Old      string        `json:"old"`
	New      string        `json:"new"`
}

// paramChange is one change request's episode in a parameter's life: what it
// proposed, where it forked from, how it ended, and who decided.
type paramChange struct {
	ID     int          `json:"id"`
	Number int          `json:"number,omitempty"`
	Title  string       `json:"title"`
	State  change.State `json:"state"`
	// Description and Category are what the reader recognises the change by
	// before they have read a single value: what it was for, and what kind of
	// change it was.
	Description  string     `json:"description,omitempty"`
	Category     string     `json:"category,omitempty"`
	Reference    string     `json:"reference,omitempty"`
	Author       string     `json:"author"`
	Branch       string     `json:"branch,omitempty"`
	TargetBranch string     `json:"targetBranch,omitempty"`
	BaseSHA      string     `json:"baseSha,omitempty"`
	CommitSHA    string     `json:"commitSha,omitempty"`
	MergeSHA     string     `json:"mergeSha,omitempty"`
	PRNumber     int        `json:"prNumber,omitempty"`
	PRURL        string     `json:"prUrl,omitempty"`
	Reviewers    []string   `json:"reviewers,omitempty"`
	Approvals    int        `json:"approvals,omitempty"`
	RejectedBy   string     `json:"rejectedBy,omitempty"`
	RejectedAt   *time.Time `json:"rejectedAt,omitempty"`
	RejectReason string     `json:"rejectReason,omitempty"`
	// ResumedFrom is the rejected change whose work this one carries;
	// ResumedInto is the change that later picked THIS one's work up. Together
	// they are what turns "rejected" from a dead end into a step: the reader
	// follows the same piece of work through its second attempt.
	ResumedFrom int         `json:"resumedFrom,omitempty"`
	ResumedInto int         `json:"resumedInto,omitempty"`
	CreatedAt   time.Time   `json:"createdAt"`
	UpdatedAt   time.Time   `json:"updatedAt"`
	Edits       []paramEdit `json:"edits"`
}

// touches reports whether an item is part of THIS parameter's story, given the
// instance the timeline is being read for.
//
// With an instance NAMED, the story is that cell's: its own edits plus the
// global ones, which belong to every instance's story because they are exactly
// the kind of change that moves a cell nobody remembers editing. Another
// instance's override is somebody else's cell and stays out.
//
// With NO instance named the story is the PARAMETER'S, and everything that
// touched it belongs in it. This started as the opposite - no instance meant
// the base value, so instance-scoped edits were filtered out - and it was
// wrong in the one way a history cannot afford to be: opening a parameter from
// its row rather than a cell (which is how people open it) showed a history
// with no change requests in it at all, on a parameter somebody had just
// edited. An edit was made, and the screen said nothing had happened. Each
// edit carries the instance it applies to, so the reader can see whose cell it
// was; showing none of them to avoid mixing them up is the worse trade by far.
func touches(it change.Item, id, instance string) bool {
	if it.ParamID != id {
		return false
	}
	if instance == "" {
		return true
	}
	return it.Scope == "global" || it.Instance == "" || it.Instance == instance
}

// paramChanges collects every change request that touched one parameter,
// newest first. Drafts are included: the reader's own unfinished work is the
// one episode they most need to see beside the published value, because it is
// the difference between the grid they are looking at and the trunk.
func (s *Server) paramChanges(id, instance string) []paramChange {
	all := s.Store.List()
	// Who picked whose work up. Built first so a rejected change can point
	// forward at its successor even when the successor is still a draft.
	resumedInto := map[int]int{}
	for _, cr := range all {
		if cr.ResumedFrom != 0 {
			resumedInto[cr.ResumedFrom] = cr.ID
		}
	}

	out := make([]paramChange, 0, 8)
	for _, cr := range all {
		var edits []paramEdit
		for _, it := range cr.Items {
			if !touches(it, id, instance) {
				continue
			}
			edits = append(edits, paramEdit{
				Instance: it.Instance,
				Scope:    it.Scope,
				Action:   it.Act(),
				// valueString, not stringify: this is the same value the trunk
				// entries carry and it has to READ the same. stringify is the
				// comparison form (it keeps 8080 and "8080" apart, which is
				// what a comparison needs and what a reader does not).
				Old: valueString(it.Old),
				New: valueString(it.New),
			})
		}
		if len(edits) == 0 {
			continue
		}
		out = append(out, paramChange{
			ID: cr.ID, Number: cr.Number, Title: cr.Title, State: cr.State,
			Description: cr.Description, Category: cr.Category, Reference: cr.Reference,
			Author: cr.Author, Branch: cr.Branch, TargetBranch: cr.TargetBranch,
			BaseSHA: cr.BaseSHA, CommitSHA: cr.CommitSHA, MergeSHA: cr.MergeSHA,
			PRNumber: cr.PRNumber, PRURL: cr.PRURL,
			Reviewers: cr.Reviewers, Approvals: len(cr.Approvals),
			RejectedBy: cr.RejectedBy, RejectedAt: cr.RejectedAt, RejectReason: cr.RejectReason,
			ResumedFrom: cr.ResumedFrom, ResumedInto: resumedInto[cr.ID],
			CreatedAt: cr.CreatedAt, UpdatedAt: cr.UpdatedAt,
			Edits: edits,
		})
	}
	return out
}

// attachChanges names, on each trunk commit, the change request that produced
// it - the CR whose own commit this is, or whose merge brought it in.
//
// Without it a value's history is a list of anonymous hashes and the reader has
// to go and look up which review each one came out of. That lookup is the whole
// question ("which change did this, and who approved it"), so the answer
// travels with the commit.
func attachChanges(entries []paramHistoryEntry, changes []paramChange) {
	if len(entries) == 0 || len(changes) == 0 {
		return
	}
	bySHA := map[string]*paramChange{}
	for i := range changes {
		c := &changes[i]
		for _, sha := range []string{c.CommitSHA, c.MergeSHA} {
			if sha != "" {
				bySHA[sha] = c
			}
		}
	}
	for i := range entries {
		c, ok := bySHA[entries[i].SHA]
		if !ok {
			continue
		}
		entries[i].ChangeID = c.ID
		entries[i].ChangeNumber = c.Number
		entries[i].ChangeTitle = c.Title
	}
}
