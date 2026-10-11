package store

import (
	"context"
	"testing"
	"time"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestUsers(t *testing.T) {
	s := open(t)
	ctx := context.Background()

	u := User{Login: "alice", Name: "Alice", Email: "a@example.com", Admin: true, CreatedAt: time.Now()}
	if err := s.UpsertUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	// Upsert refreshes fields.
	u.Name = "Alice A."
	if err := s.UpsertUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetUser(ctx, "alice")
	if err != nil || got.Name != "Alice A." || !got.Admin {
		t.Fatalf("user = %+v err=%v", got, err)
	}

}

func TestAudit(t *testing.T) {
	s := open(t)
	ctx := context.Background()

	for i := range 3 {
		if err := s.Audit(ctx, Event{Login: "bob", Repo: "app1", Action: "submit", Detail: string(rune('a' + i))}); err != nil {
			t.Fatal(err)
		}
	}
	evs, err := s.Events(ctx, "app1", 10)
	if err != nil || len(evs) != 3 {
		t.Fatalf("events = %d err=%v", len(evs), err)
	}
	if evs[0].ID < evs[1].ID {
		t.Error("events not newest-first")
	}
}

func TestAuditChainTamperEvident(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	for i := range 3 {
		if err := s.Audit(ctx, Event{Login: "bob", Repo: "app1", Action: "act", Detail: string(rune('a' + i))}); err != nil {
			t.Fatal(err)
		}
	}
	// A trail written only through Audit verifies clean.
	if ok, brokenAt, err := s.VerifyAudit(ctx); err != nil || !ok {
		t.Fatalf("fresh chain should verify: ok=%v brokenAt=%d err=%v", ok, brokenAt, err)
	}
	// Tamper: rewrite a row's detail directly, behind Audit's back.
	var midID int64
	if err := s.db.QueryRow(`SELECT id FROM audit_events ORDER BY id ASC LIMIT 1 OFFSET 1`).Scan(&midID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(s.rebind(`UPDATE audit_events SET detail = ? WHERE id = ?`), "hacked", midID); err != nil {
		t.Fatal(err)
	}
	ok, brokenAt, err := s.VerifyAudit(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if ok || brokenAt != midID {
		t.Fatalf("tamper not detected: ok=%v brokenAt=%d want brokenAt=%d", ok, brokenAt, midID)
	}
}

func TestPostgresURLGetsTheArtiAutoSchema(t *testing.T) {
	if _, err := openPostgres("postgres://u:p@localhost:5432/db?search_path=Not-Valid"); err == nil {
		t.Fatal("a schema name that is not a plain identifier was accepted")
	}
}
