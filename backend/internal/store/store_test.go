package store

import (
	"context"
	"errors"
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

func TestUsersAndSessions(t *testing.T) {
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

	if err := s.CreateSession(ctx, "tok1", "alice", time.Hour); err != nil {
		t.Fatal(err)
	}
	su, err := s.SessionUser(ctx, "tok1")
	if err != nil || su.Login != "alice" {
		t.Fatalf("session user = %+v err=%v", su, err)
	}
	// Expired sessions do not resolve.
	if err := s.CreateSession(ctx, "tok2", "alice", -time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SessionUser(ctx, "tok2"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expired session resolved: %v", err)
	}
	if err := s.DeleteSession(ctx, "tok1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SessionUser(ctx, "tok1"); !errors.Is(err, ErrNotFound) {
		t.Error("deleted session still resolves")
	}
}

func TestMembersAndAudit(t *testing.T) {
	s := open(t)
	ctx := context.Background()

	if err := s.SetMember(ctx, Member{Repo: "app1", Login: "bob", Role: RoleApprover}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetMember(ctx, Member{Repo: "app1", Login: "bob", Role: RoleViewer}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetMember(ctx, Member{Repo: "app1", Login: "eve", Role: Role("owner")}); err == nil {
		t.Error("invalid role accepted")
	}
	role, err := s.MemberRole(ctx, "app1", "bob")
	if err != nil || role != RoleViewer {
		t.Fatalf("role = %s err=%v", role, err)
	}
	if _, err := s.MemberRole(ctx, "app1", "nobody"); !errors.Is(err, ErrNotFound) {
		t.Error("missing member should be ErrNotFound")
	}
	ms, err := s.ListMembers(ctx, "app1")
	if err != nil || len(ms) != 1 {
		t.Fatalf("members = %+v err=%v", ms, err)
	}
	if err := s.RemoveMember(ctx, "app1", "bob"); err != nil {
		t.Fatal(err)
	}

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
