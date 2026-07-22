package api

// Change-request lifecycle endpoints: list, draft, detail (refreshes hosted
// PR state), submit (draft → branch + commit + PR), merge (publish), reject.

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/changeset"
)

// writeChangeError maps a change-request lifecycle error to the right status.
// A resource-state precondition is a client conflict (409); a downstream
// (GitHub/git) failure is 502, or 504 when it was a timeout; anything else is
// an unclassified 500. Clients branch on the machine code, never the message.
func writeChangeError(w http.ResponseWriter, r *http.Request, err error) {
	var conflict *changeset.ConflictError
	var up *changeset.UpstreamError
	switch {
	case errors.As(err, &conflict):
		writeError(w, r, http.StatusConflict, CodeConflict, err.Error())
	case errors.As(err, &up):
		if up.Timeout() {
			writeError(w, r, http.StatusGatewayTimeout, CodeUpstreamTimeout,
				"the change was not completed: GitHub did not respond in time, please retry shortly")
			return
		}
		writeError(w, r, http.StatusBadGateway, CodeUpstreamError,
			"the change was not completed: "+up.Op+" failed upstream, please retry shortly")
	default:
		writeErr(w, err)
	}
}

// listChanges lists change requests, newest first, cursor-paginated.
//
// @Summary     List change requests
// @Description Change requests in all states (Draft, UnderReview, Approved, Published, Rejected), newest first. Cursor-paginated: pass `limit` (default 50, max 200) and the previous response's `nextCursor`. Returns `{items, nextCursor, hasMore}`.
// @Tags        Editing & change requests
// @Produce     json
// @Param       limit  query int    false "Page size (default 50, max 200)"
// @Param       cursor query string false "Opaque cursor from the previous page"
// @Success     200 {object} Page[change.ChangeRequest]
// @Router      /api/changes [get]
func (s *Server) listChanges(w http.ResponseWriter, r *http.Request) {
	all := s.Store.List() // already newest-first by id
	limit, afterID := pageParams(r)
	items := make([]*change.ChangeRequest, 0, limit)
	page := Page[*change.ChangeRequest]{Items: items}
	for _, cr := range all {
		if afterID > 0 && int64(cr.ID) >= afterID {
			continue // cursor points past everything with id >= the last seen
		}
		if len(page.Items) == limit {
			page.HasMore = true
			page.NextCursor = encodeCursor(int64(page.Items[len(page.Items)-1].ID))
			break
		}
		page.Items = append(page.Items, cr)
	}
	writeJSON(w, http.StatusOK, page)
}

// currentDraft returns the working draft, if any.
//
// @Summary     Current draft
// @Description The current draft change request (pending, unsubmitted edits), or `{draft:null}` when there is none.
// @Tags        Editing & change requests
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Router      /api/changes/draft [get]
func (s *Server) currentDraft(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"draft": s.Store.CurrentDraft()})
}

// getChange returns one change request, refreshing hosted PR state.
//
// @Summary     Get a change request
// @Description One change request by id. Refreshes the linked pull-request state (merged/closed/checks) from the host before returning.
// @Tags        Editing & change requests
// @Produce     json
// @Param       id path int true "Change request id"
// @Success     200 {object} object
// @Failure     400 {object} APIError "Invalid id"
// @Failure     404 {object} APIError "Unknown change request"
// @Router      /api/changes/{id} [get]
func (s *Server) getChange(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid id")
		return
	}
	cr, err := s.Changes.Refresh(r.Context(), id)
	if err != nil {
		writeError(w, r, http.StatusNotFound, CodeNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, cr)
}

// previewChange returns the exact per-file before/after content a change
// request would write, without creating a branch or committing anything.
//
// @Summary     Preview a change request's file edits
// @Description The byte-level plan for a change request: for every file its value and file edits would rewrite, the exact content before and after (so the UI can show a real diff), plus +/- line counts and one-line summaries of any structural instance changes. Builds the edits in a throwaway checkout of the base branch; nothing is committed or pushed.
// @Tags        Editing & change requests
// @Produce     json
// @Param       id path int true "Change request id"
// @Success     200 {object} object
// @Failure     400 {object} APIError "Invalid id"
// @Failure     404 {object} APIError "Unknown change request"
// @Failure     502 {object} APIError "A downstream (git) step failed"
// @Router      /api/changes/{id}/preview [get]
func (s *Server) previewChange(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid id")
		return
	}
	if _, err := s.Store.Get(id); err != nil {
		writeError(w, r, http.StatusNotFound, CodeNotFound, err.Error())
		return
	}
	res, err := s.Changes.Preview(r.Context(), id)
	if err != nil {
		writeChangeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// prStatus returns the live pull-request status for a change request: CI
// checks and merge-readiness, read fresh from the host.
//
// @Summary     Pull-request status (CI + mergeability)
// @Description Live CI check roll-up (passing/failing/pending/none) and host merge-readiness for a change request's pull request, read fresh from the provider. Returns `{supported:false}` when the change has no hosted PR (pure-git deployment or not yet submitted).
// @Tags        Editing & change requests
// @Produce     json
// @Param       id path int true "Change request id"
// @Success     200 {object} object
// @Failure     400 {object} APIError "Invalid id"
// @Failure     404 {object} APIError "Unknown change request"
// @Router      /api/changes/{id}/pr-status [get]
func (s *Server) prStatus(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid id")
		return
	}
	cr, err := s.Store.Get(id)
	if err != nil {
		writeError(w, r, http.StatusNotFound, CodeNotFound, err.Error())
		return
	}
	prov := s.Backend.Provider()
	if prov == nil || cr.PRNumber == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"supported": false})
		return
	}
	pr, err := prov.Get(r.Context(), cr.PRNumber)
	if err != nil {
		// The host is unreachable or rate-limited: report unsupported rather
		// than failing the panel; the linked PR is still openable directly.
		writeJSON(w, http.StatusOK, map[string]any{"supported": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"supported": true, "pr": pr})
}

// submitChange turns a draft into a branch + commit + PR.
//
// @Summary     Submit a change request
// @Description Turn the draft into a feature branch + commit (+ hosted pull request when a provider is configured) and move it to Under Review. Async: returns 202 with the change resource whose `state` the client polls. 409 if not in a submittable state; 502/504 if a downstream (GitHub/git) step fails.
// @Tags        Editing & change requests
// @Accept      json
// @Produce     json
// @Param       id   path int                 true  "Change request id"
// @Param       body body SubmitChangeRequest false "Title, description, reference, category"
// @Success     202 {object} object
// @Failure     400 {object} APIError "Invalid id or body"
// @Failure     409 {object} APIError "Not in a submittable state"
// @Failure     502 {object} APIError "A downstream (GitHub/git) step failed"
// @Failure     504 {object} APIError "A downstream step timed out"
// @Security    CookieSession
// @Router      /api/changes/{id}/submit [post]
func (s *Server) submitChange(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid id")
		return
	}
	var req struct {
		Title       string `json:"title"`
		Description string `json:"description"`
		Reference   string `json:"reference"`
		Category    string `json:"category"`
		Author      string `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	cr, err := s.Changes.Submit(r.Context(), id, req.Title, req.Description, author(r, req.Author), req.Reference, req.Category, identity(r, req.Author))
	if err != nil {
		writeChangeError(w, r, err)
		return
	}
	// Accepted: the work continues on the host (branch/commit/PR). The client
	// polls GET /api/changes/{id} and reads `state`.
	writeJSON(w, http.StatusAccepted, cr)
}

// approveChange records approver sign-off, advancing a change to Approved.
//
// @Summary     Approve a change request
// @Description Record approver sign-off on an under-review change request, advancing it to Approved without publishing (Publish/merge is a separate step). Requires the approver role when auth is enabled. 409 if not under review.
// @Tags        Editing & change requests
// @Produce     json
// @Param       id path int true "Change request id"
// @Success     200 {object} object
// @Failure     400 {object} APIError "Invalid id"
// @Failure     403 {object} APIError "Approver role required"
// @Failure     409 {object} APIError "Not under review"
// @Security    CookieSession
// @Router      /api/changes/{id}/approve [post]
func (s *Server) approveChange(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid id")
		return
	}
	var req struct {
		Author string `json:"author"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	cr, err := s.Changes.Approve(r.Context(), id, author(r, req.Author))
	if err != nil {
		writeChangeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, cr)
}

// mergeChange publishes an approved change request.
//
// @Summary     Merge (publish) a change request
// @Description Approve and merge the change request's pull request, publishing it. Requires the approver role when auth is enabled. Async: returns 202 with the change resource; poll `state` for Published. 409 if not mergeable; 502/504 on a downstream failure.
// @Tags        Editing & change requests
// @Produce     json
// @Param       id path int true "Change request id"
// @Success     202 {object} object
// @Failure     400 {object} APIError "Invalid id"
// @Failure     403 {object} APIError "Approver role required"
// @Failure     409 {object} APIError "Not in a mergeable state"
// @Failure     502 {object} APIError "The merge failed upstream"
// @Failure     504 {object} APIError "The merge timed out upstream"
// @Security    CookieSession
// @Router      /api/changes/{id}/merge [post]
func (s *Server) mergeChange(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid id")
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	// Remember where HEAD was so we can tell our own merge apart from external
	// drift below.
	preHead, _ := s.Backend.HeadSHA(r.Context(), "HEAD")
	cr, err := s.Changes.Merge(r.Context(), id)
	if err != nil {
		writeChangeError(w, r, err)
		return
	}
	// Publishing advances HEAD with a Configer-authored commit. Without this the
	// reconcile inbox would report the tool's own publish as a change "made
	// directly on Git". Mark our merge as seen - but only when there were no
	// unacknowledged external commits before it, so genuine drift still surfaces.
	if newHead, herr := s.Backend.HeadSHA(r.Context(), "HEAD"); herr == nil && newHead != "" && newHead != preHead {
		if ack := s.Store.GetMeta(ackKey); ack == "" || ack == preHead {
			_ = s.Store.SetMeta(ackKey, newHead)
		}
	}
	writeJSON(w, http.StatusAccepted, cr)
}

// addChangeComment appends a review note to a change request. The session
// identity wins over the body's author field, like every other write.
// addChangeComment appends a review note.
//
// @Summary     Comment on a change request
// @Description Append a review note. The session identity is the author (the body's author field is only a single-user-mode fallback).
// @Tags        Editing & change requests
// @Accept      json
// @Produce     json
// @Param       id   path int            true "Change request id"
// @Param       body body CommentRequest true "The comment"
// @Success     200 {object} object
// @Failure     400 {object} APIError "Invalid id, body, or empty comment"
// @Failure     404 {object} APIError "Unknown change request"
// @Security    CookieSession
// @Router      /api/changes/{id}/comments [post]
func (s *Server) addChangeComment(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid id")
		return
	}
	var req struct {
		Body   string `json:"body"`
		Author string `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "a comment needs some text")
		return
	}
	cr, err := s.Store.Update(id, func(cr *change.ChangeRequest) error {
		cr.AddComment(author(r, req.Author), body)
		return nil
	})
	if err != nil {
		writeError(w, r, http.StatusNotFound, CodeNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, cr)
}

// setChangeReviewers replaces the reviewer list on a change request.
// Reviewers are informational: who was asked to look, not who may merge.
// setChangeReviewers replaces the reviewer list.
//
// @Summary     Set reviewers
// @Description Replace the (informational) reviewer list on a change request. Reviewers record who was asked to look, not who may merge.
// @Tags        Editing & change requests
// @Accept      json
// @Produce     json
// @Param       id   path int              true "Change request id"
// @Param       body body ReviewersRequest true "Reviewer logins"
// @Success     200 {object} object
// @Failure     400 {object} APIError "Invalid id or body"
// @Failure     404 {object} APIError "Unknown change request"
// @Security    CookieSession
// @Router      /api/changes/{id}/reviewers [put]
func (s *Server) setChangeReviewers(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid id")
		return
	}
	var req struct {
		Reviewers []string `json:"reviewers"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
		return
	}
	cr, err := s.Store.Update(id, func(cr *change.ChangeRequest) error {
		cr.SetReviewers(req.Reviewers)
		return nil
	})
	if err != nil {
		writeError(w, r, http.StatusNotFound, CodeNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, cr)
}

// rejectChange rejects or discards a change request.
//
// @Summary     Reject a change request
// @Description Reject/close the change request (a draft is discarded, a submitted one is closed).
// @Tags        Editing & change requests
// @Produce     json
// @Param       id path int true "Change request id"
// @Success     200 {object} object
// @Failure     400 {object} APIError "Invalid id"
// @Failure     409 {object} APIError "Not in a rejectable state"
// @Failure     502 {object} APIError "Closing the pull request failed upstream"
// @Security    CookieSession
// @Router      /api/changes/{id}/reject [post]
func (s *Server) rejectChange(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid id")
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	cr, err := s.Changes.Reject(r.Context(), id)
	if err != nil {
		writeChangeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, cr)
}
