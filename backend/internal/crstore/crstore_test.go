package crstore

import (
	"path/filepath"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := New(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// Drafts are scoped per author: two people editing at once each accumulate
// their own pending changeset, never a shared one, so a Submit ships only its
// author's edits.
func TestDraftsAreAuthorScoped(t *testing.T) {
	s := newStore(t)

	a, err := s.Draft("alice", "main")
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.Draft("bob", "main")
	if err != nil {
		t.Fatal(err)
	}
	if a.ID == b.ID {
		t.Fatalf("alice and bob shared draft #%d; drafts must be per author", a.ID)
	}

	// Re-requesting returns the same author's draft, not a new one or a peer's.
	again, _ := s.Draft("alice", "main")
	if again.ID != a.ID {
		t.Fatalf("second Draft(alice) = #%d, want the existing #%d", again.ID, a.ID)
	}
	if got := s.CurrentDraft("bob"); got == nil || got.ID != b.ID {
		t.Fatalf("CurrentDraft(bob) = %v, want #%d", got, b.ID)
	}
	if got := s.CurrentDraft("carol"); got != nil {
		t.Fatalf("CurrentDraft(carol) = #%d, want nil (no draft)", got.ID)
	}
}

// Author matching is case-insensitive so a login's casing never forks a draft.
func TestDraftAuthorCaseInsensitive(t *testing.T) {
	s := newStore(t)
	a, _ := s.Draft("Alice", "main")
	if got := s.CurrentDraft("alice"); got == nil || got.ID != a.ID {
		t.Fatalf("CurrentDraft(alice) did not match Draft(Alice)")
	}
}

// A submitted (non-draft) change is no longer the author's open draft, so the
// next edit starts a fresh one.
func TestDraftExcludesNonDraftStates(t *testing.T) {
	s := newStore(t)
	a, _ := s.Draft("alice", "main")
	if _, err := s.Update(a.ID, func(cr *change.ChangeRequest) error {
		cr.State = change.StateUnderReview
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if got := s.CurrentDraft("alice"); got != nil {
		t.Fatalf("CurrentDraft(alice) = #%d, want nil once submitted", got.ID)
	}
	fresh, _ := s.Draft("alice", "main")
	if fresh.ID == a.ID {
		t.Fatal("a new draft should be created after the previous one was submitted")
	}
}
