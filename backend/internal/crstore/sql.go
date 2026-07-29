package crstore

// SQLStore keeps change-request workflow state in the platform database.
//
// It exists because the file store's write is a whole-file rewrite plus an
// fsync, taken on every keystroke's worth of staging, and because a file
// cannot be shared: two Configer processes behind a load balancer would each
// hold their own idea of who is drafting what. A row per change request fixes
// both - a write touches one row, and the database is the one place both
// processes look.
//
// A change request is stored as its JSON document with the few fields the store
// actually queries on (state, author) lifted out into columns. That is a
// deliberate middle: normalizing items, comments and approvals into their own
// tables would buy nothing here, because the store never queries INTO a change
// request, only for one. The lifted columns are what "find this author's open
// draft" needs, and they are indexed.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
)

// sqlMigrations is dialect-portable DDL. Rows are scoped by application id, so
// one database serves a whole workspace.
var sqlMigrations = []string{
	`CREATE TABLE IF NOT EXISTS change_requests (
		repo       TEXT NOT NULL,
		id         BIGINT NOT NULL,
		state      TEXT NOT NULL,
		author     TEXT NOT NULL,
		updated_at TIMESTAMP NOT NULL,
		doc        TEXT NOT NULL,
		PRIMARY KEY (repo, id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_cr_repo_state ON change_requests (repo, state)`,
	`CREATE TABLE IF NOT EXISTS change_seq (
		repo TEXT PRIMARY KEY,
		next BIGINT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS change_meta (
		repo  TEXT NOT NULL,
		mkey  TEXT NOT NULL,
		mval  TEXT NOT NULL,
		PRIMARY KEY (repo, mkey)
	)`,
}

// SQLStore is a database-backed change request store for one application.
type SQLStore struct {
	db      *sql.DB
	dialect string
	repo    string
}

// NewSQL prepares the schema and returns a store for one application. db is the
// platform pool; the store never closes it.
func NewSQL(db *sql.DB, dialect, repoID string) (*SQLStore, error) {
	if db == nil {
		return nil, errors.New("crstore: no database")
	}
	if repoID == "" {
		return nil, errors.New("crstore: an application id is required")
	}
	for _, m := range sqlMigrations {
		if _, err := db.Exec(m); err != nil {
			return nil, fmt.Errorf("crstore migrate %s: %w", strings.SplitN(m, "(", 2)[0], err)
		}
	}
	return &SQLStore{db: db, dialect: dialect, repo: repoID}, nil
}

// rebind converts ?-placeholders to the dialect's own, mirroring the platform
// store's helper so both speak to the same database the same way.
func (s *SQLStore) rebind(q string) string {
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

// forUpdate is the row lock a read-modify-write needs on Postgres. SQLite runs
// the whole transaction serially (the platform pool holds it to one
// connection), so it needs no clause and has none to give.
func (s *SQLStore) forUpdate() string {
	if s.dialect == "postgres" {
		return " FOR UPDATE"
	}
	return ""
}

// tx runs fn in a transaction, rolling back on any error.
func (s *SQLStore) tx(fn func(*sql.Tx) error) error {
	ctx := context.Background()
	t, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(t); err != nil {
		_ = t.Rollback()
		return err
	}
	return t.Commit()
}

func encodeCR(cr *change.ChangeRequest) (string, error) {
	b, err := json.Marshal(cr)
	return string(b), err
}

func decodeCR(doc string) (*change.ChangeRequest, error) {
	cr := &change.ChangeRequest{}
	if err := json.Unmarshal([]byte(doc), cr); err != nil {
		return nil, fmt.Errorf("crstore: unreadable change request: %w", err)
	}
	return cr, nil
}

// notFound is the error shape callers already match on by message.
func notFound(id int) error { return fmt.Errorf("change request %d not found", id) }

// Draft returns the author's open draft, creating one if none exists.
//
// Creation and lookup happen in ONE transaction. Two requests from the same
// person arriving together - the browser staging two cells at once - would
// otherwise both find no draft and both create one, and the second edit would
// vanish into a draft nobody was looking at.
func (s *SQLStore) Draft(author, targetBranch string) (*change.ChangeRequest, error) {
	var out *change.ChangeRequest
	err := s.tx(func(t *sql.Tx) error {
		if cr, err := s.draftIn(t, author); err != nil {
			return err
		} else if cr != nil {
			out = cr
			return nil
		}
		id, err := s.nextID(t)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		cr := &change.ChangeRequest{
			ID:    id,
			Title: "Draft changes",
			// No Branch and no Number: both are decided at submit. A placeholder
			// branch read as a decision already taken - people expected their
			// work to land on "feature/unnamed" and were surprised when it did not.
			Author:       author,
			TargetBranch: targetBranch,
			State:        change.StateDraft,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		doc, err := encodeCR(cr)
		if err != nil {
			return err
		}
		if _, err := t.Exec(s.rebind(
			`INSERT INTO change_requests (repo, id, state, author, updated_at, doc) VALUES (?, ?, ?, ?, ?, ?)`),
			s.repo, cr.ID, string(cr.State), cr.Author, cr.UpdatedAt, doc); err != nil {
			return err
		}
		out = cr
		return nil
	})
	return out, err
}

// draftIn finds the author's open draft within a transaction.
func (s *SQLStore) draftIn(t *sql.Tx, author string) (*change.ChangeRequest, error) {
	rows, err := t.Query(s.rebind(
		`SELECT doc FROM change_requests WHERE repo = ? AND state = ? ORDER BY id`),
		s.repo, string(change.StateDraft))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var doc string
		if err := rows.Scan(&doc); err != nil {
			return nil, err
		}
		cr, err := decodeCR(doc)
		if err != nil {
			return nil, err
		}
		// Case-insensitive, matching the file store: an author is a login, and
		// logins are not reliably cased the same way twice.
		if strings.EqualFold(cr.Author, author) {
			return cr, nil
		}
	}
	return nil, rows.Err()
}

// nextID hands out the application's next change request number.
//
// It is a high-water mark, not MAX(id)+1: rejecting a draft deletes it, and
// numbering the next change with the id that draft had would make two entries
// in the audit trail that mean different things share a name.
func (s *SQLStore) nextID(t *sql.Tx) (int, error) {
	res, err := t.Exec(s.rebind(`UPDATE change_seq SET next = next + 1 WHERE repo = ?`), s.repo)
	if err != nil {
		return 0, err
	}
	if n, err := res.RowsAffected(); err == nil && n > 0 {
		var next int
		if err := t.QueryRow(s.rebind(`SELECT next FROM change_seq WHERE repo = ?`), s.repo).Scan(&next); err != nil {
			return 0, err
		}
		return next - 1, nil
	}
	// First change request for this application.
	if _, err := t.Exec(s.rebind(`INSERT INTO change_seq (repo, next) VALUES (?, ?)`), s.repo, 2); err != nil {
		return 0, err
	}
	return 1, nil
}

// CurrentDraft returns the author's open draft, or nil.
func (s *SQLStore) CurrentDraft(author string) *change.ChangeRequest {
	var out *change.ChangeRequest
	err := s.tx(func(t *sql.Tx) error {
		cr, err := s.draftIn(t, author)
		out = cr
		return err
	})
	if err != nil {
		return nil
	}
	return out
}

// Get returns one change request by id.
func (s *SQLStore) Get(id int) (*change.ChangeRequest, error) {
	var doc string
	err := s.db.QueryRow(s.rebind(
		`SELECT doc FROM change_requests WHERE repo = ? AND id = ?`), s.repo, id).Scan(&doc)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound(id)
	}
	if err != nil {
		return nil, err
	}
	return decodeCR(doc)
}

// List returns every change request for this application, newest first.
func (s *SQLStore) List() []*change.ChangeRequest {
	rows, err := s.db.Query(s.rebind(
		`SELECT doc FROM change_requests WHERE repo = ? ORDER BY id DESC`), s.repo)
	if err != nil {
		return nil
	}
	defer func() { _ = rows.Close() }()
	out := []*change.ChangeRequest{}
	for rows.Next() {
		var doc string
		if err := rows.Scan(&doc); err != nil {
			return out
		}
		cr, err := decodeCR(doc)
		if err != nil {
			continue // one unreadable row must not hide the rest of the list
		}
		out = append(out, cr)
	}
	// ORDER BY already does this; re-sorting keeps the contract true even if a
	// row arrives out of order from a dialect that collates ids as text.
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	return out
}

// Update applies fn to the stored change request inside a transaction, so a
// read-modify-write is atomic against every other writer - including one in
// another process.
func (s *SQLStore) Update(id int, fn func(*change.ChangeRequest) error) (*change.ChangeRequest, error) {
	var out *change.ChangeRequest
	err := s.tx(func(t *sql.Tx) error {
		var doc string
		err := t.QueryRow(s.rebind(
			`SELECT doc FROM change_requests WHERE repo = ? AND id = ?`+s.forUpdate()), s.repo, id).Scan(&doc)
		if errors.Is(err, sql.ErrNoRows) {
			return notFound(id)
		}
		if err != nil {
			return err
		}
		cr, err := decodeCR(doc)
		if err != nil {
			return err
		}
		if err := fn(cr); err != nil {
			return err
		}
		cr.UpdatedAt = time.Now().UTC()
		next, err := encodeCR(cr)
		if err != nil {
			return err
		}
		if _, err := t.Exec(s.rebind(
			`UPDATE change_requests SET state = ?, author = ?, updated_at = ?, doc = ? WHERE repo = ? AND id = ?`),
			string(cr.State), cr.Author, cr.UpdatedAt, next, s.repo, id); err != nil {
			return err
		}
		out = cr
		return nil
	})
	return out, err
}

// Delete removes a change request.
func (s *SQLStore) Delete(id int) error {
	res, err := s.db.Exec(s.rebind(
		`DELETE FROM change_requests WHERE repo = ? AND id = ?`), s.repo, id)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return notFound(id)
	}
	return nil
}

// GetMeta reads a small operational value ("" when unset).
func (s *SQLStore) GetMeta(key string) string {
	var v string
	if err := s.db.QueryRow(s.rebind(
		`SELECT mval FROM change_meta WHERE repo = ? AND mkey = ?`), s.repo, key).Scan(&v); err != nil {
		return ""
	}
	return v
}

// SetMeta writes a small operational value.
func (s *SQLStore) SetMeta(key, value string) error {
	return s.tx(func(t *sql.Tx) error {
		res, err := t.Exec(s.rebind(
			`UPDATE change_meta SET mval = ? WHERE repo = ? AND mkey = ?`), value, s.repo, key)
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err == nil && n > 0 {
			return nil
		}
		_, err = t.Exec(s.rebind(
			`INSERT INTO change_meta (repo, mkey, mval) VALUES (?, ?, ?)`), s.repo, key, value)
		return err
	})
}

// Empty reports whether this application has no change requests recorded yet.
// Import uses it to decide whether there is anything to take over.
func (s *SQLStore) Empty() (bool, error) {
	var n int
	if err := s.db.QueryRow(s.rebind(
		`SELECT COUNT(*) FROM change_requests WHERE repo = ?`), s.repo).Scan(&n); err != nil {
		return false, err
	}
	return n == 0, nil
}

// Import copies an existing file store's contents in, once.
//
// Upgrading a running deployment must not lose the change requests already in
// flight: somebody's half-written draft and last week's published history are
// exactly what a user would notice missing. It refuses to run over a database
// that already holds change requests for this application, so it is safe to
// call on every startup and does nothing after the first.
func (s *SQLStore) Import(from *FileStore) error {
	empty, err := s.Empty()
	if err != nil || !empty {
		return err
	}
	crs := from.List() // newest first; insert oldest first so ids read naturally
	if len(crs) == 0 {
		return nil
	}
	return s.tx(func(t *sql.Tx) error {
		high := 0
		for i := len(crs) - 1; i >= 0; i-- {
			cr := crs[i]
			doc, err := encodeCR(cr)
			if err != nil {
				return err
			}
			if _, err := t.Exec(s.rebind(
				`INSERT INTO change_requests (repo, id, state, author, updated_at, doc) VALUES (?, ?, ?, ?, ?, ?)`),
				s.repo, cr.ID, string(cr.State), cr.Author, cr.UpdatedAt, doc); err != nil {
				return err
			}
			if cr.ID > high {
				high = cr.ID
			}
		}
		// Carry the numbering across, so the first change made after the move
		// does not reuse an id the file store already handed out.
		_, err := t.Exec(s.rebind(`INSERT INTO change_seq (repo, next) VALUES (?, ?)`), s.repo, high+1)
		return err
	})
}
