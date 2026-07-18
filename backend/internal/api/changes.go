package api

// Change-request lifecycle endpoints: list, draft, detail (refreshes hosted
// PR state), submit (draft → branch + commit + PR), merge (publish), reject.

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
)

// listChanges lists every change request.
//
// @Summary     List change requests
// @Description Every change request in the store, in all states (Draft, UnderReview, Approved, Published, Rejected).
// @Tags        Editing & change requests
// @Produce     json
// @Success     200 {array} object
// @Router      /api/changes [get]
func (s *Server) listChanges(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Store.List())
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

// submitChange turns a draft into a branch + commit + PR.
//
// @Summary     Submit a change request
// @Description Turn the draft into a feature branch + commit (+ hosted pull request when a provider is configured) and move it to Under Review. Idempotency: a change already submitted returns 409.
// @Tags        Editing & change requests
// @Accept      json
// @Produce     json
// @Param       id   path int                 true  "Change request id"
// @Param       body body SubmitChangeRequest false "Title, description, reference, category"
// @Success     200 {object} object
// @Failure     400 {object} APIError "Invalid id or body"
// @Failure     409 {object} APIError "Not in a submittable state, or push/PR failed"
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
		writeError(w, r, http.StatusConflict, CodeConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, cr)
}

// mergeChange publishes an approved change request.
//
// @Summary     Merge (publish) a change request
// @Description Approve and merge the change request's pull request, publishing it. Requires the approver role when auth is enabled.
// @Tags        Editing & change requests
// @Produce     json
// @Param       id path int true "Change request id"
// @Success     200 {object} object
// @Failure     400 {object} APIError "Invalid id"
// @Failure     403 {object} APIError "Approver role required"
// @Failure     409 {object} APIError "Not in a mergeable state, or merge failed"
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
	cr, err := s.Changes.Merge(r.Context(), id)
	if err != nil {
		writeError(w, r, http.StatusConflict, CodeConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, cr)
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
		writeError(w, r, http.StatusConflict, CodeConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, cr)
}
