package crstore

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/change"

	_ "modernc.org/sqlite" // sqlite driver (pure Go)
)

// Both implementations must behave identically - that is what makes the
// interface a seam rather than a fork in behaviour, and it is the only thing
// standing between a deployment on Postgres and a subtly different product.
// Every test below runs against both.
func eachStore(t *testing.T, fn func(*testing.T, Store)) {
	t.Helper()
	t.Run("file", func(t *testing.T) { fn(t, newFileStore(t)) })
	t.Run("sql", func(t *testing.T) { fn(t, newSQLStore(t)) })
}

func newFileStore(t *testing.T) *FileStore {
	t.Helper()
	s, err := New(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func newSQLStore(t *testing.T) *SQLStore {
	t.Helper()
	db := openTestDB(t)
	s, err := NewSQL(db, "sqlite", "app-under-test")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "test.db") + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1) // as the platform pool does
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// Drafts are scoped per author: two people editing at once each accumulate
// their own pending changeset, never a shared one, so a Submit ships only its
// author's edits.
func TestDraftsAreAuthorScoped(t *testing.T) {
	eachStore(t, func(t *testing.T, s Store) {
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
	})
}

// Author matching is case-insensitive so a login's casing never forks a draft.
func TestDraftAuthorCaseInsensitive(t *testing.T) {
	eachStore(t, func(t *testing.T, s Store) {
		a, _ := s.Draft("Alice", "main")
		if got := s.CurrentDraft("alice"); got == nil || got.ID != a.ID {
			t.Fatalf("CurrentDraft(alice) did not match Draft(Alice)")
		}
	})
}

// A submitted (non-draft) change is no longer the author's open draft, so the
// next edit starts a fresh one.
func TestDraftExcludesNonDraftStates(t *testing.T) {
	eachStore(t, func(t *testing.T, s Store) {
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
	})
}

// A change request handed out by the store is a copy. Editing one in place
// must not reach the store - the rule that lets a database back it, and that
// removes the "did this persist?" coin flip the file store used to have.
func TestReadsHandOutCopies(t *testing.T) {
	eachStore(t, func(t *testing.T, s Store) {
		cr, err := s.Draft("alice", "main")
		if err != nil {
			t.Fatal(err)
		}
		cr.Title = "edited in place"
		cr.UpsertItem(change.Item{ParamID: "p1", Instance: "staging", New: 1})

		stored, err := s.Get(cr.ID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.Title == "edited in place" {
			t.Error("a title set on a returned copy reached the store")
		}
		if len(stored.Items) != 0 {
			t.Errorf("an item staged on a returned copy reached the store: %v", stored.Items)
		}

		// Update is the way in, and it does persist.
		if _, err := s.Update(cr.ID, func(c *change.ChangeRequest) error {
			c.Title = "through update"
			c.UpsertItem(change.Item{ParamID: "p1", Instance: "staging", New: 1})
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		stored, _ = s.Get(cr.ID)
		if stored.Title != "through update" || len(stored.Items) != 1 {
			t.Errorf("Update did not persist: %q with %d items", stored.Title, len(stored.Items))
		}

		// And two readers never share mutable state.
		one, _ := s.Get(cr.ID)
		two, _ := s.Get(cr.ID)
		one.Items[0].New = 999
		if two.Items[0].New == 999 {
			t.Error("two readers were handed the same items slice")
		}
	})
}

// Full lifecycle over the interface: list ordering, meta, delete.
func TestStoreLifecycle(t *testing.T) {
	eachStore(t, func(t *testing.T, s Store) {
		a, _ := s.Draft("alice", "main")
		if _, err := s.Update(a.ID, func(cr *change.ChangeRequest) error {
			cr.State = change.StatePublished
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		b, _ := s.Draft("bob", "main")

		list := s.List()
		if len(list) != 2 {
			t.Fatalf("List = %d change requests, want 2", len(list))
		}
		if list[0].ID != b.ID {
			t.Errorf("List is not newest-first: got #%d first", list[0].ID)
		}

		if got := s.GetMeta("ack"); got != "" {
			t.Errorf("unset meta = %q, want empty", got)
		}
		if err := s.SetMeta("ack", "abc123"); err != nil {
			t.Fatal(err)
		}
		if got := s.GetMeta("ack"); got != "abc123" {
			t.Errorf("meta = %q, want abc123", got)
		}
		if err := s.SetMeta("ack", "def456"); err != nil {
			t.Fatal(err)
		}
		if got := s.GetMeta("ack"); got != "def456" {
			t.Errorf("meta after overwrite = %q, want def456", got)
		}

		if err := s.Delete(b.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Get(b.ID); err == nil {
			t.Error("Get should fail after Delete")
		}
		if err := s.Delete(b.ID); err == nil {
			t.Error("deleting a missing change request should report it")
		}
	})
}

// Numbering is a high-water mark, not MAX(id)+1: a rejected draft's number is
// never handed out again, so two entries in the audit trail cannot share a name.
func TestIDsAreNotReusedAfterDelete(t *testing.T) {
	eachStore(t, func(t *testing.T, s Store) {
		a, _ := s.Draft("alice", "main")
		if err := s.Delete(a.ID); err != nil {
			t.Fatal(err)
		}
		next, _ := s.Draft("alice", "main")
		if next.ID == a.ID {
			t.Fatalf("change request #%d was handed out twice", a.ID)
		}
	})
}

// One database serves a whole workspace, so two applications must not see each
// other's change requests.
func TestSQLStoreIsScopedPerApplication(t *testing.T) {
	db := openTestDB(t)
	one, err := NewSQL(db, "sqlite", "app-one")
	if err != nil {
		t.Fatal(err)
	}
	two, err := NewSQL(db, "sqlite", "app-two")
	if err != nil {
		t.Fatal(err)
	}

	a, _ := one.Draft("alice", "main")
	if _, err := one.Update(a.ID, func(cr *change.ChangeRequest) error {
		cr.Title = "one's change"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := one.SetMeta("ack", "sha-one"); err != nil {
		t.Fatal(err)
	}

	if got := two.List(); len(got) != 0 {
		t.Errorf("app-two sees app-one's change requests: %d", len(got))
	}
	if got := two.CurrentDraft("alice"); got != nil {
		t.Error("app-two sees app-one's draft")
	}
	if got := two.GetMeta("ack"); got != "" {
		t.Errorf("app-two sees app-one's meta: %q", got)
	}

	// Numbering is per application, so both applications have a change #1 and
	// each id must resolve within its OWN application.
	b, _ := two.Draft("alice", "main")
	if b.ID != a.ID {
		t.Fatalf("app-two started numbering at #%d, want its own #%d", b.ID, a.ID)
	}
	mine, err := one.Get(a.ID)
	if err != nil || mine.Title != "one's change" {
		t.Fatalf("app-one's change #%d was overwritten by app-two's: %+v (err %v)", a.ID, mine, err)
	}
	theirs, err := two.Get(b.ID)
	if err != nil || theirs.Title == "one's change" {
		t.Fatalf("app-two's change #%d resolved into app-one's: %+v (err %v)", b.ID, theirs, err)
	}
}

// Upgrading a running deployment must not lose work in flight: the drafts and
// history already in the file come across, once, and keep their numbering.
func TestSQLStoreImportsAnExistingFile(t *testing.T) {
	file := newFileStore(t)
	published, _ := file.Draft("alice", "main")
	if _, err := file.Update(published.ID, func(cr *change.ChangeRequest) error {
		cr.Title = "Already published"
		cr.State = change.StatePublished
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	inFlight, _ := file.Draft("bob", "main")
	if _, err := file.Update(inFlight.ID, func(cr *change.ChangeRequest) error {
		cr.UpsertItem(change.Item{ParamID: "p1", Instance: "staging", New: 9090})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := file.SetMeta("ack", "sha-from-the-file"); err != nil {
		t.Fatal(err)
	}

	sqlStore := newSQLStore(t)
	if err := sqlStore.Import(file); err != nil {
		t.Fatal(err)
	}

	if got := len(sqlStore.List()); got != 2 {
		t.Fatalf("imported %d change requests, want 2", got)
	}
	moved, err := sqlStore.Get(published.ID)
	if err != nil || moved.Title != "Already published" || moved.State != change.StatePublished {
		t.Fatalf("published change did not survive the move: %+v (err %v)", moved, err)
	}
	draft := sqlStore.CurrentDraft("bob")
	if draft == nil || len(draft.Items) != 1 {
		t.Fatalf("bob's in-flight draft did not survive the move: %+v", draft)
	}

	// Numbering carries across, so the next change does not reuse an id.
	next, _ := sqlStore.Draft("carol", "main")
	if next.ID <= inFlight.ID {
		t.Fatalf("next change request #%d reuses an id the file already gave out (highest was #%d)",
			next.ID, inFlight.ID)
	}

	// Importing again over a populated database changes nothing.
	if err := sqlStore.Import(file); err != nil {
		t.Fatal(err)
	}
	if got := len(sqlStore.List()); got != 3 {
		t.Fatalf("a second import duplicated rows: %d change requests", got)
	}
}
