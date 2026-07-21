package search

import (
	"database/sql"
	"strings"
)

// The durable tier: a single FTS5 virtual table over all applications. app_id,
// type, doc_id, target, and badges are UNINDEXED (stored, not tokenized); title,
// subtitle, and keywords are the matchable columns. modernc.org/sqlite compiles
// FTS5 in by default, so no build tags are needed.
func createFTS(db *sql.DB) error {
	_, err := db.Exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_docs USING fts5(
		app_id UNINDEXED,
		type UNINDEXED,
		doc_id UNINDEXED,
		title,
		subtitle,
		keywords,
		target UNINDEXED,
		badges UNINDEXED
	)`)
	return err
}

func ftsReplace(db *sql.DB, appID string, docs []Doc) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`DELETE FROM search_docs WHERE app_id = ?`, appID); err != nil {
		return err
	}
	stmt, err := tx.Prepare(`INSERT INTO search_docs
		(app_id, type, doc_id, title, subtitle, keywords, target, badges)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()
	for _, d := range docs {
		if _, err := stmt.Exec(d.AppID, d.Type, d.DocID, d.Title, d.Subtitle, d.Keywords,
			string(d.Target), encodeBadges(d.Badges)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func ftsDelete(db *sql.DB, appID string) error {
	_, err := db.Exec(`DELETE FROM search_docs WHERE app_id = ?`, appID)
	return err
}

func ftsSearch(db *sql.DB, q, appID string, limit int) ([]Hit, error) {
	match := ftsQuery(q)
	if match == "" {
		return nil, nil
	}
	query := `SELECT app_id, type, doc_id, title, subtitle, keywords, target, badges
		FROM search_docs WHERE search_docs MATCH ?`
	args := []any{match}
	if appID != "" {
		query += ` AND app_id = ?`
		args = append(args, appID)
	}
	query += ` ORDER BY bm25(search_docs) LIMIT ?`
	args = append(args, limit)

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var hits []Hit
	for rows.Next() {
		var h Hit
		var target, badges string
		if err := rows.Scan(&h.AppID, &h.Type, &h.ID, &h.Title, &h.Subtitle, &h.Keywords, &target, &badges); err != nil {
			return nil, err
		}
		h.Target = []byte(target)
		h.Badges = decodeBadges(badges)
		hits = append(hits, h)
	}
	return hits, rows.Err()
}

// ftsQuery turns a free-text query into a safe FTS5 MATCH expression: each
// alphanumeric token becomes a quoted prefix term ("net"*), joined by spaces
// (implicit AND). Quoting neutralizes FTS5 operators so user input cannot form a
// malformed or injected query.
func ftsQuery(q string) string {
	fields := strings.FieldsFunc(strings.ToLower(q), func(r rune) bool {
		return !(r >= 'a' && r <= 'z') && !(r >= '0' && r <= '9')
	})
	if len(fields) == 0 {
		return ""
	}
	terms := make([]string, 0, len(fields))
	for _, f := range fields {
		terms = append(terms, `"`+f+`"*`)
	}
	return strings.Join(terms, " ")
}
