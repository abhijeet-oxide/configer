package workspace

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite" // sqlite driver (pure Go)
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "test.db") + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func newSQL(t *testing.T) *SQLRegistry {
	t.Helper()
	r, err := NewSQL(testDB(t), "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// Both implementations answer to the same interface, so both are held to the
// same behaviour.
func eachRegistry(t *testing.T, fn func(*testing.T, Registry)) {
	t.Helper()
	t.Run("file", func(t *testing.T) {
		r, err := Load(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		fn(t, r)
	})
	t.Run("sql", func(t *testing.T) { fn(t, newSQL(t)) })
}

func entry(id, name string) Entry {
	return Entry{ID: id, Name: name, Origin: "https://example.com/" + id + ".git",
		Path: "/data/repos/" + id, Branch: "main", AddedAt: time.Now().UTC().Truncate(time.Second)}
}

func TestRegistryLifecycle(t *testing.T) {
	eachRegistry(t, func(t *testing.T, r Registry) {
		if err := r.Add(entry("alpha", "Alpha")); err != nil {
			t.Fatal(err)
		}
		if err := r.Add(entry("beta", "Beta")); err != nil {
			t.Fatal(err)
		}
		if err := r.Add(entry("alpha", "Alpha again")); err == nil {
			t.Fatal("a duplicate id was accepted")
		}

		// Connection order matters: the first entry is the default application.
		list := r.List()
		if len(list) != 2 || list[0].ID != "alpha" || list[1].ID != "beta" {
			t.Fatalf("List lost connection order: %+v", list)
		}

		got, ok := r.Get("beta")
		if !ok || got.Name != "Beta" || got.Origin == "" || got.Branch != "main" {
			t.Fatalf("Get(beta) = %+v (ok=%v)", got, ok)
		}
		if _, ok := r.Get("nope"); ok {
			t.Fatal("Get returned an entry that was never added")
		}

		// Renaming keeps the id, so deep links and per-repo routes survive it.
		renamed, ok := r.Rename("beta", "Beta Renamed")
		if !ok || renamed.ID != "beta" || renamed.Name != "Beta Renamed" {
			t.Fatalf("Rename = %+v (ok=%v)", renamed, ok)
		}
		if _, ok := r.Rename("nope", "x"); ok {
			t.Fatal("Rename reported success for an unknown id")
		}

		removed, ok := r.Remove("alpha")
		if !ok || removed.ID != "alpha" {
			t.Fatalf("Remove = %+v (ok=%v)", removed, ok)
		}
		if _, ok := r.Remove("alpha"); ok {
			t.Fatal("Remove reported success twice for one entry")
		}
		if list := r.List(); len(list) != 1 || list[0].ID != "beta" {
			t.Fatalf("after Remove: %+v", list)
		}
	})
}

func TestRegistryUniqueID(t *testing.T) {
	eachRegistry(t, func(t *testing.T, r Registry) {
		if got := r.UniqueID("ran", nil); got != "ran" {
			t.Fatalf("first UniqueID = %q, want ran", got)
		}
		if err := r.Add(entry("ran", "RAN")); err != nil {
			t.Fatal(err)
		}
		if got := r.UniqueID("ran", nil); got != "ran-2" {
			t.Fatalf("UniqueID after a clash = %q, want ran-2", got)
		}
		// An id reserved by an in-flight connection is spoken for too: it names
		// a FOLDER, and two clones in one directory destroy each other.
		if got := r.UniqueID("ran", map[string]bool{"ran-2": true}); got != "ran-3" {
			t.Fatalf("UniqueID ignoring a reserved id = %q, want ran-3", got)
		}
	})
}

// Every field has to survive the round trip, including the flags that decide
// how a repository is opened and the token that lets it be fetched at all.
func TestSQLRegistryPreservesEveryField(t *testing.T) {
	r := newSQL(t)
	want := Entry{
		ID: "telco", Name: "Telco RAN", Origin: "https://github.com/acme/ran.git",
		Path: "/data/repos/telco", Branch: "release", Local: true, Remote: true,
		Token: "ghp-secret", AddedAt: time.Now().UTC().Truncate(time.Second),
	}
	if err := r.Add(want); err != nil {
		t.Fatal(err)
	}
	got, ok := r.Get("telco")
	if !ok {
		t.Fatal("the entry did not come back")
	}
	if got.Name != want.Name || got.Origin != want.Origin || got.Path != want.Path ||
		got.Branch != want.Branch || got.Local != want.Local || got.Remote != want.Remote ||
		got.Token != want.Token || !got.AddedAt.Equal(want.AddedAt) {
		t.Fatalf("round trip changed the entry:\n got %+v\nwant %+v", got, want)
	}
}

// Upgrading must not disconnect what somebody already connected.
func TestSQLRegistryImportsAnExistingFile(t *testing.T) {
	dir := t.TempDir()
	file, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Add(entry("alpha", "Alpha")); err != nil {
		t.Fatal(err)
	}
	if err := file.Add(entry("beta", "Beta")); err != nil {
		t.Fatal(err)
	}

	db := testDB(t)
	r, err := NewSQL(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Import(file); err != nil {
		t.Fatal(err)
	}
	list := r.List()
	if len(list) != 2 || list[0].ID != "alpha" || list[1].ID != "beta" {
		t.Fatalf("import lost entries or their order: %+v", list)
	}

	// A second import over a populated database is a no-op, so it is safe on
	// every startup.
	if err := r.Import(file); err != nil {
		t.Fatal(err)
	}
	if got := len(r.List()); got != 2 {
		t.Fatalf("a second import duplicated rows: %d entries", got)
	}

	// And a fresh process reading the same database sees the same workspace,
	// which is the whole point: another replica, or this one after a restart
	// onto an empty disk.
	next, err := NewSQL(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if got := len(next.List()); got != 2 {
		t.Fatalf("a second process saw %d applications, want 2", got)
	}
}
