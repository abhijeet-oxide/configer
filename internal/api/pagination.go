package api

// One pagination standard for every growing collection, so no endpoint can
// ever accidentally stream an unbounded dataset. Cursor pagination (not offset)
// is used for append-heavy, time-ordered collections (change requests, audit
// events): a cursor is stable under concurrent inserts, where an offset would
// skip or repeat rows. The cursor is an opaque, monotonic id encoded so clients
// treat it as a token, never as a number to compute on.

import (
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
)

const (
	defaultPageSize = 50
	maxPageSize     = 200
)

// Page is the envelope every paginated collection returns. Items is never null
// (an empty page is `[]`), and NextCursor is "" when there is no next page.
type Page[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"nextCursor,omitempty"`
	HasMore    bool   `json:"hasMore"`
}

// pageParams reads and clamps the `limit` and `cursor` query parameters. The
// returned limit is always within [1, maxPageSize]; afterID is the decoded
// cursor (0 when absent or malformed - a bad cursor starts from the top rather
// than erroring, which is the friendlier, still-safe behavior).
func pageParams(r *http.Request) (limit int, afterID int64) {
	limit = defaultPageSize
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > maxPageSize {
		limit = maxPageSize
	}
	return limit, decodeCursor(r.URL.Query().Get("cursor"))
}

// encodeCursor turns a last-seen id into an opaque token.
func encodeCursor(id int64) string {
	if id <= 0 {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString([]byte("id:" + strconv.FormatInt(id, 10)))
}

// decodeCursor recovers the id from a token, or 0 when it is absent/invalid.
func decodeCursor(cursor string) int64 {
	if cursor == "" {
		return 0
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return 0
	}
	s := strings.TrimPrefix(string(raw), "id:")
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	return n
}
