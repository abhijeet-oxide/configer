// Package change defines the change-request domain: a set of pending
// parameter edits that travels through the git-native lifecycle
// Draft -> Under Review (PR open) -> Approved -> Published (merged),
// with Rejected as the terminal failure state.
package change

import "time"

// State is a change request's lifecycle position.
type State string

const (
	StateDraft       State = "draft"
	StateUnderReview State = "under_review"
	StateApproved    State = "approved"
	StatePublished   State = "published"
	StateRejected    State = "rejected"
)

// Item is one pending cell edit: a (parameter, instance) value change.
type Item struct {
	ParamID   string    `json:"paramId"`
	Instance  string    `json:"instance"`
	Old       any       `json:"old"`
	New       any       `json:"new"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// ChangeRequest is a reviewable unit of configuration change. While in draft
// it accumulates items; on submit it becomes a git branch + commit (+ PR when
// a provider is configured) and advances through the state machine.
type ChangeRequest struct {
	ID           int    `json:"id"`
	Title        string `json:"title"`
	Description  string `json:"description,omitempty"`
	Author       string `json:"author"`
	TargetBranch string `json:"targetBranch"`
	Branch       string `json:"branch,omitempty"`
	BaseSHA      string `json:"baseSha,omitempty"`
	CommitSHA    string `json:"commitSha,omitempty"`
	State        State  `json:"state"`
	Items        []Item `json:"items"`
	PRNumber     int    `json:"prNumber,omitempty"`
	PRURL        string `json:"prUrl,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// UpsertItem adds or replaces the pending edit for (paramID, instance),
// preserving the original Old value across successive edits of the same cell.
func (cr *ChangeRequest) UpsertItem(it Item) {
	for i := range cr.Items {
		if cr.Items[i].ParamID == it.ParamID && cr.Items[i].Instance == it.Instance {
			it.Old = cr.Items[i].Old // first observed value stays the baseline
			cr.Items[i] = it
			return
		}
	}
	cr.Items = append(cr.Items, it)
}

// RemoveItem drops the pending edit for (paramID, instance) and reports
// whether one existed.
func (cr *ChangeRequest) RemoveItem(paramID, instance string) bool {
	for i := range cr.Items {
		if cr.Items[i].ParamID == paramID && cr.Items[i].Instance == instance {
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
