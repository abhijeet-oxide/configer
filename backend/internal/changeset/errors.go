package changeset

// Typed errors so the HTTP layer can tell three very different failures apart
// and answer with the right status:
//
//   - ConflictError: the client asked for something the resource's own state
//     forbids (submit a non-draft, merge a non-under-review, nothing to submit).
//     Retrying the identical request will not help. -> 409 Conflict.
//   - UpstreamError: a downstream dependency (GitHub, git push/merge, the PR
//     provider) failed. The client did nothing wrong; a retry with backoff may
//     succeed. -> 502 Bad Gateway (or 504 when the cause is a deadline).
//
// Anything not wrapped is treated as an unexpected server fault (500). The API
// layer classifies via errors.As / errors.Is; see api/changes.go.

import (
	"context"
	"errors"
	"fmt"
)

// ConflictError marks a resource-state precondition failure (client error).
type ConflictError struct{ msg string }

func (e *ConflictError) Error() string { return e.msg }

func conflictf(format string, a ...any) error {
	return &ConflictError{msg: fmt.Sprintf(format, a...)}
}

// UpstreamError marks a downstream-dependency failure (GitHub, git, provider).
// It preserves the cause so a deadline can be detected and reported as 504.
type UpstreamError struct {
	// Op is a short, user-safe description of what was attempted
	// ("open pull request", "publish the change"), used to build a message that
	// never leaks git or infrastructure detail.
	Op  string
	Err error
}

func (e *UpstreamError) Error() string { return e.Op + ": " + e.Err.Error() }
func (e *UpstreamError) Unwrap() error { return e.Err }

// Timeout reports whether the upstream failure was a deadline/cancellation,
// which the API maps to 504 Gateway Timeout rather than 502.
func (e *UpstreamError) Timeout() bool {
	return errors.Is(e.Err, context.DeadlineExceeded) || errors.Is(e.Err, context.Canceled)
}

func upstream(op string, err error) error {
	if err == nil {
		return nil
	}
	return &UpstreamError{Op: op, Err: err}
}
