package api

// The platform-wide error contract. Every error response carries a stable,
// machine-readable `code` a client can branch on without parsing prose, a
// human-readable `error`, the `requestId` that correlates it to the access log
// and the X-Request-ID response header, and - for validation failures - a
// `fields` list naming exactly what was rejected. The `error` field is kept
// (rather than renamed) so existing clients keep working: this is an additive
// contract, not a breaking one.
//
// This is deliberately a lightweight, JSON-native shape rather than RFC 9457
// (application/problem+json): the whole API speaks application/json and the
// frontend already reads `error`, so a parallel media type would add ceremony
// without value. The fields map cleanly onto Problem Details if that is ever
// desired (code->type, error->detail, requestId->instance).

import "net/http"

// Stable error codes. These are part of the API contract: clients may switch
// on them, so treat a rename as a breaking change. Group by concern.
const (
	// Request shape / input.
	CodeBadRequest       = "bad_request"       // malformed body, missing/!parseable input
	CodeValidationFailed = "validation_failed" // schema/business-rule validation (422)
	CodeUnsupportedMedia = "unsupported_media" // wrong Content-Type (415)
	CodePayloadTooLarge  = "payload_too_large" // body exceeded the limit (413)

	// Identity / access.
	CodeUnauthorized = "unauthorized" // not signed in (401)
	CodeForbidden    = "forbidden"    // signed in, role insufficient (403)

	// Resource state.
	CodeNotFound = "not_found" // resource does not exist (404)
	CodeConflict = "conflict"  // resource-state clash: name taken, wrong state (409)

	// Dependencies / server.
	CodeUpstreamError = "upstream_error" // a downstream (GitHub/git) call failed (502)
	CodeUnavailable   = "unavailable"    // not ready to serve (503)
	CodeInternalError = "internal_error" // unexpected, unclassified server fault (500)
)

// FieldError names one field-level validation failure so a form can highlight
// exactly the input that was rejected instead of showing a generic banner.
type FieldError struct {
	Field   string `json:"field" example:"port"`
	Message string `json:"message" example:"must be between 1 and 65535"`
}

// APIError is the single error envelope every endpoint returns on 4xx/5xx.
type APIError struct {
	// Error is a human-readable, plain-language message safe to show a user.
	// It never contains git jargon, stack traces, credentials, or internal
	// hostnames.
	Error string `json:"error" example:"parameter not found"`
	// Code is the stable, machine-readable classifier a client branches on.
	Code string `json:"code" example:"not_found"`
	// RequestID correlates this response with the access log and the
	// X-Request-ID header, so an operator can find the exact request.
	RequestID string `json:"requestId,omitempty" example:"3f9a1c2b7e5d0a84"`
	// Fields carries per-field validation failures (422 only).
	Fields []FieldError `json:"fields,omitempty"`
}

// codeForStatus is the default machine code for a status when a handler does
// not name a more specific one, so even un-migrated call sites stay classified.
func codeForStatus(status int) string {
	switch status {
	case http.StatusBadRequest:
		return CodeBadRequest
	case http.StatusUnauthorized:
		return CodeUnauthorized
	case http.StatusForbidden:
		return CodeForbidden
	case http.StatusNotFound:
		return CodeNotFound
	case http.StatusConflict:
		return CodeConflict
	case http.StatusRequestEntityTooLarge:
		return CodePayloadTooLarge
	case http.StatusUnsupportedMediaType:
		return CodeUnsupportedMedia
	case http.StatusUnprocessableEntity:
		return CodeValidationFailed
	case http.StatusBadGateway:
		return CodeUpstreamError
	case http.StatusServiceUnavailable:
		return CodeUnavailable
	default:
		return CodeInternalError
	}
}

// writeError is the standard way to answer with an error. It fills the
// machine-readable code and the correlation id from the request context, so
// every migrated call site is consistent for free.
func writeError(w http.ResponseWriter, r *http.Request, status int, code, msg string) {
	if code == "" {
		code = codeForStatus(status)
	}
	writeJSON(w, status, APIError{Error: msg, Code: code, RequestID: reqID(r)})
}

// writeFieldErrors answers 422 with per-field validation detail.
func writeFieldErrors(w http.ResponseWriter, r *http.Request, msg string, fields ...FieldError) {
	writeJSON(w, http.StatusUnprocessableEntity, APIError{
		Error: msg, Code: CodeValidationFailed, RequestID: reqID(r), Fields: fields,
	})
}

// reqID pulls the correlation id from the request (set by withObservability).
func reqID(r *http.Request) string {
	if r == nil {
		return ""
	}
	return requestID(r.Context())
}
