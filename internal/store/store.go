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
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // postgres driver
	_ "modernc.org/sqlite"             // sqlite driver (pure Go)
)

// User is a signed-in person, as the platform's identity provider names them.
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
	// auditMu serializes audit appends so the hash chain reads its predecessor
	// and writes its successor atomically (the trail is low-volume).
	auditMu sync.Mutex
}

// Open connects to the platform database: DATABASE_URL when set (postgres),
// otherwise an embedded SQLite file under dataDir. The schema is migrated in
// place on open.
func Open(dataDir, databaseURL string) (*Store, error) {
	var db *sql.DB
	var dialect string
	var err error
	if databaseURL != "" {
		db, err = openPostgres(databaseURL)
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
	tunePool(db, dialect)
	s := &Store{db: db, dialect: dialect}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate %s: %w", dialect, err)
	}
	s.ensureAuditColumns()
	return s, nil
}

// ensureAuditColumns adds the audit hash-chain columns to databases created
// before the chain existed. It is best effort and idempotent: on a fresh schema
// (columns already present) each ALTER simply errors and is ignored. The column
// names are fixed constants, never user input.
func (s *Store) ensureAuditColumns() {
	for _, col := range []string{"prev_hash", "hash"} {
		_, _ = s.db.Exec(fmt.Sprintf(
			`ALTER TABLE audit_events ADD COLUMN %s TEXT NOT NULL DEFAULT ''`, col))
	}
}

// tunePool sets connection-pool limits so the store behaves under load. SQLite
// is a single-writer file even in WAL mode, so more than one open connection
// just produces "database is locked" contention; one connection serializes
// writes cleanly (the platform DB is low-traffic: sessions, roles, audit).
// Postgres gets a bounded pool with a lifetime cap so a burst cannot exhaust
// server connections and stale connections are recycled.
func tunePool(db *sql.DB, dialect string) {
	if dialect == "sqlite" {
		db.SetMaxOpenConns(1)
		return
	}
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(25)
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetConnMaxIdleTime(2 * time.Minute)
}

// openPostgres opens the platform database with ArtiAuto's tables in their own
// schema. The database is shared with Software Gateway, whose tables are in
// public; a search_path already in the URL wins.
func openPostgres(databaseURL string) (*sql.DB, error) {
	u, err := url.Parse(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("DATABASE_URL is not a URL: %w", err)
	}
	q := u.Query()
	schema := q.Get("search_path")
	if schema == "" {
		schema = DefaultSchema
		q.Set("search_path", schema)
		u.RawQuery = q.Encode()
	}
	if !schemaName.MatchString(schema) {
		return nil, fmt.Errorf("schema %q is not a plain lower-case name", schema)
	}
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(`CREATE SCHEMA IF NOT EXISTS ` + schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("create schema %s: %w", schema, err)
	}
	return db, nil
}

// DefaultSchema holds ArtiAuto's tables in the shared platform database.
const DefaultSchema = "artiauto"

var schemaName = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

// Close releases the database.
func (s *Store) Close() error { return s.db.Close() }

// Dialect names the active backend ("sqlite" or "postgres").
func (s *Store) Dialect() string { return s.dialect }

// DB exposes the shared connection so a derived index (e.g. the search FTS5
// table) can live in the same database. The returned handle is the store's own
// pool; callers must not close it.
func (s *Store) DB() *sql.DB { return s.db }

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
	`CREATE TABLE IF NOT EXISTS audit_events (
		id        BIGINT NOT NULL,
		at        TIMESTAMP NOT NULL,
		login     TEXT NOT NULL,
		repo      TEXT NOT NULL DEFAULT '',
		action    TEXT NOT NULL,
		detail    TEXT NOT NULL DEFAULT '',
		prev_hash TEXT NOT NULL DEFAULT '',
		hash      TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events (at)`,
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

// --- audit ---------------------------------------------------------------------

// Audit appends an event to the audit trail (best effort: an audit failure
// never blocks the action itself; callers may ignore the error). Each row is
// linked into a hash chain - its hash covers the previous row's hash plus this
// event's contents - so any later edit or deletion of a row breaks the chain
// and is detectable via VerifyAudit. The canonical event time is the id
// (nanoseconds), which is part of the hash; the `at` column is a readable copy.
func (s *Store) Audit(ctx context.Context, e Event) error {
	if e.At.IsZero() {
		e.At = time.Now().UTC()
	}
	s.auditMu.Lock()
	defer s.auditMu.Unlock()

	var prevHash string
	if err := s.db.QueryRowContext(ctx,
		`SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1`).Scan(&prevHash); err != nil &&
		!errors.Is(err, sql.ErrNoRows) {
		return err
	}
	// Portable id: nanoseconds; collisions are broken by retrying once.
	id := e.At.UnixNano()
	for range 2 {
		hash := auditHash(prevHash, id, e.Login, e.Repo, e.Action, e.Detail)
		_, err := s.db.ExecContext(ctx, s.rebind(
			`INSERT INTO audit_events (id, at, login, repo, action, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
			id, e.At, e.Login, e.Repo, e.Action, e.Detail, prevHash, hash)
		if err == nil {
			return nil
		}
		id++
	}
	return fmt.Errorf("audit insert failed")
}

// auditHash computes one link of the tamper-evident chain: SHA-256 over the
// previous row's hash and this event's canonical fields (id is the nanosecond
// event time). A unit separator delimits fields so values cannot collide.
func auditHash(prevHash string, id int64, login, repo, action, detail string) string {
	payload := strings.Join([]string{
		prevHash, strconv.FormatInt(id, 10), login, repo, action, detail,
	}, "\x1f")
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}

// VerifyAudit walks the trail oldest-first and recomputes the hash chain. It
// returns ok=false with brokenAt set to the id of the first row whose stored
// hash or predecessor link does not match its contents - evidence the trail was
// altered after the fact.
func (s *Store) VerifyAudit(ctx context.Context) (ok bool, brokenAt int64, err error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, login, repo, action, detail, prev_hash, hash FROM audit_events ORDER BY id ASC`)
	if err != nil {
		return false, 0, err
	}
	defer rows.Close()
	prevHash := ""
	for rows.Next() {
		var id int64
		var login, repo, action, detail, storedPrev, storedHash string
		if err := rows.Scan(&id, &login, &repo, &action, &detail, &storedPrev, &storedHash); err != nil {
			return false, 0, err
		}
		if storedPrev != prevHash || auditHash(prevHash, id, login, repo, action, detail) != storedHash {
			return false, id, nil
		}
		prevHash = storedHash
	}
	return true, 0, rows.Err()
}

// Events lists the newest audit entries (optionally for one application).
func (s *Store) Events(ctx context.Context, repo string, limit int) ([]Event, error) {
	return s.EventsBefore(ctx, repo, limit, 0)
}

// EventsBefore is Events with cursor support: only events with id < beforeID
// (0 = from the newest) are returned, so the API can paginate a growing trail
// without an offset that would skip or repeat rows under concurrent inserts.
func (s *Store) EventsBefore(ctx context.Context, repo string, limit int, beforeID int64) ([]Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	q := `SELECT id, at, login, repo, action, detail FROM audit_events `
	args := []any{}
	where := []string{}
	if repo != "" {
		where = append(where, `repo = ?`)
		args = append(args, repo)
	}
	if beforeID > 0 {
		where = append(where, `id < ?`)
		args = append(args, beforeID)
	}
	if len(where) > 0 {
		q += `WHERE ` + strings.Join(where, ` AND `) + ` `
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
