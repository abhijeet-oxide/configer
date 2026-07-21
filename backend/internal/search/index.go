package search

import (
	"database/sql"
	"sort"
	"strings"
	"sync"
)

// Index is the two-tier global metadata index: a bounded in-memory tier serving
// hot queries, backed by a durable SQLite FTS5 tier. At realistic scale the
// whole index lives in memory and queries never touch disk; once the memory cap
// (memMax docs) is exceeded, queries fall through to FTS5, which holds the full
// set. On Postgres deployments (no FTS5) the index runs memory-only and is
// rebuilt from the registry on start - persistence is a warm-start optimization,
// never the source of truth.
type Index struct {
	mu       sync.RWMutex
	apps     map[string][]Doc
	total    int
	memMax   int
	overflow bool

	db  *sql.DB // nil unless the durable tier is available
	fts bool    // SQLite FTS5 present
}

// New builds an index. When db is a SQLite connection the FTS5 tier is created
// and used; otherwise the index is memory-only.
func New(db *sql.DB, dialect string, memMax int) (*Index, error) {
	if memMax <= 0 {
		memMax = 50000
	}
	ix := &Index{apps: map[string][]Doc{}, memMax: memMax}
	if db != nil && dialect == "sqlite" {
		if err := createFTS(db); err != nil {
			return nil, err
		}
		ix.db = db
		ix.fts = true
	}
	return ix, nil
}

// ReplaceApp atomically swaps the documents for one application in both tiers.
func (ix *Index) ReplaceApp(appID string, docs []Doc) error {
	ix.mu.Lock()
	ix.total += len(docs) - len(ix.apps[appID])
	if len(docs) == 0 {
		delete(ix.apps, appID)
	} else {
		ix.apps[appID] = docs
	}
	ix.overflow = ix.total > ix.memMax
	ix.mu.Unlock()

	if ix.fts {
		return ftsReplace(ix.db, appID, docs)
	}
	return nil
}

// RemoveApp drops an application from both tiers (on disconnect).
func (ix *Index) RemoveApp(appID string) error {
	ix.mu.Lock()
	ix.total -= len(ix.apps[appID])
	delete(ix.apps, appID)
	ix.overflow = ix.total > ix.memMax
	ix.mu.Unlock()

	if ix.fts {
		return ftsDelete(ix.db, appID)
	}
	return nil
}

// Search returns up to limit candidate hits for a query. Ranking here is for
// candidate selection only; the client re-ranks the merged local+global set with
// the same scorer, so exact ordering parity is not required. An empty query
// returns nothing (the client fills the empty state with instant local hits).
func (ix *Index) Search(q, scope, appID string, limit int) ([]Hit, error) {
	q = strings.TrimSpace(q)
	if q == "" {
		return nil, nil
	}
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	ix.mu.RLock()
	overflow := ix.overflow
	ix.mu.RUnlock()
	if overflow && ix.fts {
		return ftsSearch(ix.db, q, appID, limit)
	}
	return ix.memSearch(q, appID, limit)
}

type scored struct {
	hit   Hit
	score float64
}

func (ix *Index) memSearch(q, appID string, limit int) ([]Hit, error) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()

	var out []scored
	scan := func(docs []Doc) {
		for _, d := range docs {
			if s, ok := bestScore(q, d.Title, d.Keywords); ok {
				out = append(out, scored{hit: d.toHit(), score: s})
			}
		}
	}
	if appID != "" {
		scan(ix.apps[appID])
	} else {
		for _, docs := range ix.apps {
			scan(docs)
		}
	}

	sort.SliceStable(out, func(i, j int) bool { return out[i].score > out[j].score })
	if len(out) > limit {
		out = out[:limit]
	}
	hits := make([]Hit, len(out))
	for i, s := range out {
		hits[i] = s.hit
	}
	return hits, nil
}
