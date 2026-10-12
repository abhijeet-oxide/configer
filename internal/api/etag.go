package api

// Optimistic concurrency for the direct-commit catalog writes (parameter
// metadata, application identity). Value edits do not need this: they stage
// into a single owned draft and upsert, so they cannot lose each other's work.
// Direct commits to the working branch can: two admins editing the same
// parameter would otherwise be last-write-wins, silently.
//
// The concurrency token is the working branch's HEAD commit SHA - the catalog
// "revision". Every catalog READ returns it in the ETag header; a catalog WRITE
// must echo it in If-Match. Because any catalog change advances HEAD, a write
// built on a stale view is rejected with 412 and the user is told to reload.
// This is deliberately coarse (a change to any catalog resource invalidates an
// in-flight edit of another): these are infrequent admin actions, and refusing
// a possibly-stale write is the safe default. Precision (per-resource ETags)
// is a later refinement if it is ever needed.

import (
	"context"
	"net/http"
	"strings"
)

// catalogRev returns the current catalog revision (working HEAD SHA), or "" if
// it cannot be determined (in which case concurrency control is skipped rather
// than blocking every write).
func (s *Server) catalogRev() string {
	sha, err := s.Backend.HeadSHA(context.Background(), "HEAD")
	if err != nil {
		return ""
	}
	return sha
}

// setRev tags a catalog read with the current revision so the client can echo
// it on the next write. Weak-quoted per RFC 7232.
func setRev(w http.ResponseWriter, rev string) {
	if rev != "" {
		w.Header().Set("ETag", `"`+rev+`"`)
	}
}

// requireIfMatch gates a direct-commit catalog write. It answers:
//   - 428 Precondition Required when the client sent no If-Match (the guard is
//     mandatory: a blind write could clobber a concurrent change);
//   - 412 Precondition Failed when the client's revision is stale;
//
// and returns true only when the write may proceed. When the revision cannot be
// determined server-side it lets the write through (fail-open beats blocking
// every edit on a backend that cannot report HEAD).
func (s *Server) requireIfMatch(w http.ResponseWriter, r *http.Request) bool {
	rev := s.catalogRev()
	if rev == "" {
		return true
	}
	setRev(w, rev)
	im := strings.TrimSpace(r.Header.Get("If-Match"))
	if im == "" {
		writeError(w, r, http.StatusPreconditionRequired, CodePreconditionRequired,
			"this edit must carry the version it was based on; reload and try again")
		return false
	}
	if im == "*" {
		return true // explicit "any current version" per RFC 7232
	}
	if unquoteETag(im) != rev {
		writeError(w, r, http.StatusPreconditionFailed, CodeConflict,
			"this changed since you loaded it; reload to see the latest, then reapply your edit")
		return false
	}
	return true
}

// unquoteETag strips optional weak prefix and quotes from an ETag/If-Match value.
func unquoteETag(v string) string {
	v = strings.TrimPrefix(v, "W/")
	return strings.Trim(v, `"`)
}
