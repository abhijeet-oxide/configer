// Package store persists Configer's PLATFORM data: users, sessions,
// per-application roles, and the audit trail. Configuration itself never
// lives here - Git remains the single source of truth for values and
// metadata; this database is only about who may do what, and who did.
//
// The default backend is embedded SQLite (pure Go, zero external services,
// one file under the data directory). Setting DATABASE_URL switches to
// PostgreSQL for production deployments. One dialect-portable schema serves
// both.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // postgres driver
	_ "modernc.org/sqlite"             // sqlite driver (pure Go)
)

// User is an authenticated person (GitHub identity).
type User struct {
	Login     string    `json:"login"`
	Name      string    `json:"name,omitempty"`
	Email     string    `json:"email,omitempty"`
	AvatarURL string    `json:"avatarUrl,omitempty"`
	Admin     bool      `json:"admin"`
	CreatedAt time.Time `json:"createdAt"`
}

// Role is a user's capability level on one application.
type Role string

const (
	RoleViewer   Role = "viewer"
	RoleEditor   Role = "editor"
	RoleApprover Role = "approver"
)

// Valid reports whether r is a known role.
func (r Role) Valid() bool {
	return r == RoleViewer || r == RoleEditor || r == RoleApprover
}

// Member is one user's role on one application.
type Member struct {
	Repo  string `json:"repo"` // workspace application id
	Login string `json:"login"`
	Role  Role   `json:"role"`
}

// Event is one audit-trail entry.
type Event struct {
	ID     int64     `json:"id"`
	At     time.Time `json:"at"`
	Login  string    `json:"login"`
	Repo   string    `json:"repo,omitempty"`
	Action string    `json:"action"`
	Detail string    `json:"detail,omitempty"`
}

// ErrNotFound marks a missing row.
var ErrNotFound = errors.New("not found")

// Store is the platform database.
type Store struct {
	db      *sql.DB
	dialect string // "sqlite" | "postgres"
}

// Open connects to the platform database: DATABASE_URL when set (postgres),
// otherwise an embedded SQLite file under dataDir. The schema is migrated in
// place on open.
func Open(dataDir, databaseURL string) (*Store, error) {
	var db *sql.DB
	var dialect string
	var err error
	if databaseURL != "" {
		db, err = sql.Open("pgx", databaseURL)
		dialect = "postgres"
	} else {
		if err := os.MkdirAll(dataDir, 0o755); err != nil {
			return nil, err
		}
		dsn := "file:" + filepath.Join(dataDir, "configer.db") + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"
		db, err = sql.Open("sqlite", dsn)
		dialect = "sqlite"
	}
	if err != nil {
		return nil, err
	}
	s := &Store{db: db, dialect: dialect}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate %s: %w", dialect, err)
	}
	return s, nil
}

// Close releases the database.
func (s *Store) Close() error { return s.db.Close() }

// Dialect names the active backend ("sqlite" or "postgres").
func (s *Store) Dialect() string { return s.dialect }

// migrations are dialect-portable statements (SERIAL vs AUTOINCREMENT is
// avoided by generating ids in the driver-portable ways below).
var migrations = []string{
	`CREATE TABLE IF NOT EXISTS users (
		login       TEXT PRIMARY KEY,
		name        TEXT NOT NULL DEFAULT '',
		email       TEXT NOT NULL DEFAULT '',
		avatar_url  TEXT NOT NULL DEFAULT '',
		is_admin    BOOLEAN NOT NULL DEFAULT FALSE,
		created_at  TIMESTAMP NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS sessions (
		token       TEXT PRIMARY KEY,
		login       TEXT NOT NULL,
		expires_at  TIMESTAMP NOT NULL,
		created_at  TIMESTAMP NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS app_members (
		repo   TEXT NOT NULL,
		login  TEXT NOT NULL,
		role   TEXT NOT NULL,
		PRIMARY KEY (repo, login)
	)`,
	`CREATE TABLE IF NOT EXISTS audit_events (
		id      BIGINT NOT NULL,
		at      TIMESTAMP NOT NULL,
		login   TEXT NOT NULL,
		repo    TEXT NOT NULL DEFAULT '',
		action  TEXT NOT NULL,
		detail  TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events (at)`,
	`CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at)`,
}

func (s *Store) migrate() error {
	for _, m := range migrations {
		if _, err := s.db.Exec(m); err != nil {
			return fmt.Errorf("%s: %w", strings.SplitN(m, "(", 2)[0], err)
		}
	}
	return nil
}

// rebind converts ?-placeholders to the dialect's own ($1… for postgres).
func (s *Store) rebind(q string) string {
	if s.dialect != "postgres" {
		return q
	}
	var b strings.Builder
	n := 0
	for _, r := range q {
		if r == '?' {
			n++
			fmt.Fprintf(&b, "$%d", n)
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// --- users -------------------------------------------------------------------

// UpsertUser records (or refreshes) a user identity.
func (s *Store) UpsertUser(ctx context.Context, u User) error {
	_, err := s.db.ExecContext(ctx, s.rebind(`
		INSERT INTO users (login, name, email, avatar_url, is_admin, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (login) DO UPDATE SET name = excluded.name,
			email = excluded.email, avatar_url = excluded.avatar_url,
			is_admin = excluded.is_admin`),
		u.Login, u.Name, u.Email, u.AvatarURL, u.Admin, u.CreatedAt.UTC())
	return err
}

// GetUser fetches a user by login.
func (s *Store) GetUser(ctx context.Context, login string) (User, error) {
	var u User
	err := s.db.QueryRowContext(ctx, s.rebind(
		`SELECT login, name, email, avatar_url, is_admin, created_at FROM users WHERE login = ?`), login).
		Scan(&u.Login, &u.Name, &u.Email, &u.AvatarURL, &u.Admin, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return u, err
}

// ListUsers returns every known user, newest first.
func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT login, name, email, avatar_url, is_admin, created_at FROM users ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.Login, &u.Name, &u.Email, &u.AvatarURL, &u.Admin, &u.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// --- sessions ------------------------------------------------------------------

// CreateSession stores a session token for a user.
func (s *Store) CreateSession(ctx context.Context, token, login string, ttl time.Duration) error {
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, s.rebind(
		`INSERT INTO sessions (token, login, expires_at, created_at) VALUES (?, ?, ?, ?)`),
		token, login, now.Add(ttl), now)
	return err
}

// SessionUser resolves a session token to its user (ErrNotFound when the
// token is unknown or expired).
func (s *Store) SessionUser(ctx context.Context, token string) (User, error) {
	var login string
	err := s.db.QueryRowContext(ctx, s.rebind(
		`SELECT login FROM sessions WHERE token = ? AND expires_at > ?`), token, time.Now().UTC()).
		Scan(&login)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, err
	}
	return s.GetUser(ctx, login)
}

// DeleteSession logs a session out.
func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, s.rebind(`DELETE FROM sessions WHERE token = ?`), token)
	return err
}

// PruneSessions drops expired sessions.
func (s *Store) PruneSessions(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, s.rebind(`DELETE FROM sessions WHERE expires_at <= ?`), time.Now().UTC())
	return err
}

// --- application members ---------------------------------------------------------

// SetMember assigns a user's role on an application (delete via RemoveMember).
func (s *Store) SetMember(ctx context.Context, m Member) error {
	if !m.Role.Valid() {
		return fmt.Errorf("unknown role %q", m.Role)
	}
	_, err := s.db.ExecContext(ctx, s.rebind(`
		INSERT INTO app_members (repo, login, role) VALUES (?, ?, ?)
		ON CONFLICT (repo, login) DO UPDATE SET role = excluded.role`),
		m.Repo, m.Login, string(m.Role))
	return err
}

// RemoveMember clears a user's explicit role on an application.
func (s *Store) RemoveMember(ctx context.Context, repo, login string) error {
	_, err := s.db.ExecContext(ctx, s.rebind(
		`DELETE FROM app_members WHERE repo = ? AND login = ?`), repo, login)
	return err
}

// ListMembers returns the explicit role assignments for one application.
func (s *Store) ListMembers(ctx context.Context, repo string) ([]Member, error) {
	rows, err := s.db.QueryContext(ctx, s.rebind(
		`SELECT repo, login, role FROM app_members WHERE repo = ? ORDER BY login`), repo)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Member
	for rows.Next() {
		var m Member
		if err := rows.Scan(&m.Repo, &m.Login, &m.Role); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// MemberRole returns a user's explicit role on an application (ErrNotFound
// when none is assigned; callers apply the deployment default).
func (s *Store) MemberRole(ctx context.Context, repo, login string) (Role, error) {
	var r string
	err := s.db.QueryRowContext(ctx, s.rebind(
		`SELECT role FROM app_members WHERE repo = ? AND login = ?`), repo, login).Scan(&r)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return Role(r), err
}

// --- audit ---------------------------------------------------------------------

// Audit appends an event to the audit trail (best effort: an audit failure
// never blocks the action itself; callers may ignore the error).
func (s *Store) Audit(ctx context.Context, e Event) error {
	if e.At.IsZero() {
		e.At = time.Now().UTC()
	}
	// Portable id: nanoseconds; collisions are broken by retrying once.
	id := e.At.UnixNano()
	for range 2 {
		_, err := s.db.ExecContext(ctx, s.rebind(
			`INSERT INTO audit_events (id, at, login, repo, action, detail) VALUES (?, ?, ?, ?, ?, ?)`),
			id, e.At, e.Login, e.Repo, e.Action, e.Detail)
		if err == nil {
			return nil
		}
		id++
	}
	return fmt.Errorf("audit insert failed")
}

// Events lists the newest audit entries (optionally for one application).
func (s *Store) Events(ctx context.Context, repo string, limit int) ([]Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	q := `SELECT id, at, login, repo, action, detail FROM audit_events `
	args := []any{}
	if repo != "" {
		q += `WHERE repo = ? `
		args = append(args, repo)
	}
	q += fmt.Sprintf(`ORDER BY id DESC LIMIT %d`, limit)
	rows, err := s.db.QueryContext(ctx, s.rebind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Event
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.At, &e.Login, &e.Repo, &e.Action, &e.Detail); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
