package workspace

// SQLRegistry keeps the connected-repository list in the platform database.
//
// It is the last piece of per-process state that stopped a Configer pod being
// disposable. Everything else a restart needs is either reconstructible (the
// working copies, which are just a cache of the origin) or already in the
// database (change requests, users, roles, the audit trail); the registry was a
// JSON file on one machine's disk, so a second replica did not know which
// applications existed and a restarted pod with a fresh volume knew about none
// of them.
//
// It is small, low-traffic data - a handful of rows, read when an application
// is opened and written when one is connected or renamed - so unlike the change
// request store there is no reason to keep a file implementation for small
// deployments. FileRegistry remains only to be read once and imported.

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// sqlMigrations is dialect-portable DDL.
//
// Key columns are VARCHAR rather than TEXT deliberately: MySQL cannot index a
// TEXT column without a prefix length, and 191 is the longest utf8mb4 column
// that fits its index limit. SQLite and Postgres treat this as any other
// string. That does not make Configer run on MySQL today - the platform store
// has no MySQL driver and the older tables still use TEXT keys - but it means
// this table will not be the reason it cannot.
var sqlMigrations = []string{
	`CREATE TABLE IF NOT EXISTS workspace_repos (
		id        VARCHAR(191) NOT NULL,
		name      TEXT NOT NULL,
		origin    TEXT NOT NULL,
		path      TEXT NOT NULL DEFAULT '',
		branch    TEXT NOT NULL DEFAULT '',
		is_local  BOOLEAN NOT NULL DEFAULT FALSE,
		is_remote BOOLEAN NOT NULL DEFAULT FALSE,
		token     TEXT NOT NULL DEFAULT '',
		added_at  TIMESTAMP NOT NULL,
		position  BIGINT NOT NULL,
		PRIMARY KEY (id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_workspace_position ON workspace_repos (position)`,
}

// SQLRegistry is the database-backed registry.
type SQLRegistry struct {
	db      *sql.DB
	dialect string
}

// NewSQL prepares the schema and returns a registry over the platform pool.
// The pool is shared and is never closed here.
func NewSQL(db *sql.DB, dialect string) (*SQLRegistry, error) {
	if db == nil {
		return nil, errors.New("workspace: no database")
	}
	for _, m := range sqlMigrations {
		if _, err := db.Exec(m); err != nil {
			return nil, fmt.Errorf("workspace migrate %s: %w", strings.SplitN(m, "(", 2)[0], err)
		}
	}
	return &SQLRegistry{db: db, dialect: dialect}, nil
}

func (r *SQLRegistry) rebind(q string) string {
	if r.dialect != "postgres" {
		return q
	}
	var b strings.Builder
	n := 0
	for _, c := range q {
		if c == '?' {
			n++
			fmt.Fprintf(&b, "$%d", n)
			continue
		}
		b.WriteRune(c)
	}
	return b.String()
}

const selectCols = `id, name, origin, path, branch, is_local, is_remote, token, added_at`

func scanEntry(sc interface{ Scan(...any) error }) (Entry, error) {
	var e Entry
	err := sc.Scan(&e.ID, &e.Name, &e.Origin, &e.Path, &e.Branch, &e.Local, &e.Remote, &e.Token, &e.AddedAt)
	return e, err
}

// List returns the entries in connection order (first = default repository).
func (r *SQLRegistry) List() []Entry {
	rows, err := r.db.Query(`SELECT ` + selectCols + ` FROM workspace_repos ORDER BY position`)
	if err != nil {
		return nil
	}
	defer func() { _ = rows.Close() }()
	out := []Entry{}
	for rows.Next() {
		e, serr := scanEntry(rows)
		if serr != nil {
			return out
		}
		out = append(out, e)
	}
	return out
}

// Get looks an entry up by id.
func (r *SQLRegistry) Get(id string) (Entry, bool) {
	row := r.db.QueryRow(r.rebind(`SELECT `+selectCols+` FROM workspace_repos WHERE id = ?`), id)
	e, err := scanEntry(row)
	if err != nil {
		return Entry{}, false
	}
	return e, true
}

// Add appends a new entry; the id must be unique.
func (r *SQLRegistry) Add(e Entry) error {
	if _, taken := r.Get(e.ID); taken {
		return fmt.Errorf("repository id %q already exists", e.ID)
	}
	var next int64
	if err := r.db.QueryRow(`SELECT COALESCE(MAX(position), 0) + 1 FROM workspace_repos`).Scan(&next); err != nil {
		return err
	}
	if e.AddedAt.IsZero() {
		e.AddedAt = time.Now().UTC()
	}
	_, err := r.db.Exec(r.rebind(
		`INSERT INTO workspace_repos (`+selectCols+`, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		e.ID, e.Name, e.Origin, e.Path, e.Branch, e.Local, e.Remote, e.Token, e.AddedAt, next)
	return err
}

// Remove deletes an entry and returns it.
func (r *SQLRegistry) Remove(id string) (Entry, bool) {
	e, ok := r.Get(id)
	if !ok {
		return Entry{}, false
	}
	if _, err := r.db.Exec(r.rebind(`DELETE FROM workspace_repos WHERE id = ?`), id); err != nil {
		return Entry{}, false
	}
	return e, true
}

// Rename changes an entry's display name; its id stays stable so deep links and
// per-repo routes keep working.
func (r *SQLRegistry) Rename(id, name string) (Entry, bool) {
	res, err := r.db.Exec(r.rebind(`UPDATE workspace_repos SET name = ? WHERE id = ?`), name, id)
	if err != nil {
		return Entry{}, false
	}
	if n, rerr := res.RowsAffected(); rerr == nil && n == 0 {
		return Entry{}, false
	}
	return r.Get(id)
}

// UniqueID derives an unused registry id from a base slug. `taken` names ids
// spoken for outside the registry - a connection still in progress - because an
// id IS a folder on the server: handing the same one to a second attempt puts
// two clones in one directory, and they destroy each other's work.
func (r *SQLRegistry) UniqueID(base string, taken map[string]bool) string {
	if base == "" {
		base = "repo"
	}
	used := map[string]bool{}
	for id := range taken {
		used[id] = true
	}
	for _, e := range r.List() {
		used[e.ID] = true
	}
	if !used[base] {
		return base
	}
	for n := 2; ; n++ {
		id := fmt.Sprintf("%s-%d", base, n)
		if !used[id] {
			return id
		}
	}
}

// Empty reports whether any repository is recorded yet.
func (r *SQLRegistry) Empty() (bool, error) {
	var n int
	if err := r.db.QueryRow(`SELECT COUNT(*) FROM workspace_repos`).Scan(&n); err != nil {
		return false, err
	}
	return n == 0, nil
}

// Import copies an existing workspace.json in, once.
//
// Upgrading must not disconnect everything somebody already connected. It
// refuses to run over a database that already holds repositories, so it is safe
// to call on every startup and does nothing after the first.
func (r *SQLRegistry) Import(from *FileRegistry) error {
	empty, err := r.Empty()
	if err != nil || !empty {
		return err
	}
	entries := from.List()
	if len(entries) == 0 {
		return nil
	}
	for _, e := range entries {
		if aerr := r.Add(e); aerr != nil {
			return aerr
		}
	}
	return nil
}
