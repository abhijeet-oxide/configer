package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"time"

	"github.com/abhijeet-oxide/configer/internal/auth"
	"github.com/abhijeet-oxide/configer/internal/change"
	"github.com/abhijeet-oxide/configer/internal/gitengine"
	"github.com/abhijeet-oxide/configer/internal/plugin"
	"github.com/abhijeet-oxide/configer/internal/store"
	"github.com/abhijeet-oxide/configer/internal/transformers"
)

// Release candidates are requested in Software Gateway and written to
// public.release_candidates in the platform database (docs/design/69 in the
// platform repository). This side claims them, finds the application connected
// to the product's repository, asks a Transformer plugin for the files that
// deploy the release, and submits them as an ordinary change request.

const (
	candidateQueued    = "queued"
	candidateWaiting   = "waiting"
	candidateSucceeded = "succeeded"
	candidateFailed    = "failed"

	// The author a release candidate's change request names.
	candidateLogin = "release-candidates"
)

type candidateQueue interface {
	// Claim takes the oldest queued request, or a waiting one whose reason may
	// have gone away; false when there is none.
	Claim(ctx context.Context, worker string) (plugin.ReleaseCandidate, bool, error)
	Settle(ctx context.Context, id, state, resultURL, detail string) error
}

type candidateRunner struct {
	hub     *Hub
	queue   candidateQueue
	plugins *plugin.Registry
	worker  string
}

// StartReleaseCandidates runs the runner until ctx ends. It needs the platform
// database: on SQLite there is no Software Gateway to have asked.
func (h *Hub) StartReleaseCandidates(ctx context.Context, every time.Duration) {
	if h.platform == nil || h.platform.Dialect() != "postgres" {
		return
	}
	reg := plugin.NewRegistry()
	transformers.Register(reg)
	host, _ := os.Hostname()
	c := &candidateRunner{hub: h, queue: pgCandidates{db: h.platform.DB()}, plugins: reg, worker: host}
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			for {
				more, err := c.once(ctx)
				if err != nil {
					h.log().Warn("release candidates: claim failed", slog.Any("error", err))
				}
				if !more || err != nil {
					break
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
}

// once handles one request. It reports whether there was one.
func (c *candidateRunner) once(ctx context.Context) (bool, error) {
	rc, ok, err := c.queue.Claim(ctx, c.worker)
	if err != nil || !ok {
		return false, err
	}
	state, url, detail := c.process(ctx, rc)
	if err := c.queue.Settle(ctx, rc.ID, state, url, detail); err != nil {
		return true, err
	}
	c.hub.log().Info("release candidate settled", slog.String("id", rc.ID),
		slog.String("product", rc.Product), slog.String("release", rc.Release), slog.String("state", state))
	return true, nil
}

func (c *candidateRunner) process(ctx context.Context, rc plugin.ReleaseCandidate) (state, url, detail string) {
	id, ok := c.applicationFor(rc.GitURL)
	if !ok {
		return candidateWaiting, "", "no application in ArtiAuto is connected to " + gitengine.Redact(rc.GitURL)
	}
	t, ok := c.plugins.TransformerFor(rc)
	if !ok {
		return candidateWaiting, "", "no transformer plugin is installed in ArtiAuto"
	}
	if !c.hub.ensureOpen(id) {
		return candidateFailed, "", "the application connected to this repository could not be opened"
	}
	srv, handler := c.hub.server(id)
	if srv == nil || handler == nil {
		return candidateFailed, "", "the application connected to this repository could not be opened"
	}
	files, err := t.Transform(ctx, rc, os.DirFS(srv.RepoPath))
	if err != nil {
		return candidateFailed, "", t.Manifest().Name + ": " + err.Error()
	}
	if len(files) == 0 {
		return candidateSucceeded, "", "the configuration already deploys this release"
	}
	cr, err := proposeCandidate(ctx, srv, handler, rc, files)
	if err != nil {
		return candidateFailed, "", err.Error()
	}
	return candidateSucceeded, cr.PRURL, fmt.Sprintf("change request CR-%d", cr.Number)
}

// proposeCandidate stages files and submits them, through the same handlers a
// person's edit goes through, so validation, branch naming and the pull
// request are the same.
func proposeCandidate(ctx context.Context, srv *Server, handler http.Handler, rc plugin.ReleaseCandidate, files []plugin.FileChange) (*change.ChangeRequest, error) {
	ctx = auth.WithUser(ctx, store.User{Login: candidateLogin, Name: "Release candidate"})
	call := func(method, path string, body any) (*httptest.ResponseRecorder, *http.Request) {
		b, _ := json.Marshal(body)
		req := httptest.NewRequestWithContext(ctx, method, path, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec, req
	}
	var owner string
	for _, f := range files {
		rec, req := call(http.MethodPut, "/api/files/draft", map[string]any{"path": f.Path, "content": string(f.Content)})
		if rec.Code >= 300 {
			return nil, fmt.Errorf("staging %s: %s", f.Path, strings.TrimSpace(rec.Body.String()))
		}
		owner = draftOwner(req)
	}
	draft := srv.Store.CurrentDraft(owner)
	if draft == nil {
		return nil, errors.New("the transformer's files change nothing in the repository")
	}
	rec, _ := call(http.MethodPost, fmt.Sprintf("/api/changes/%d/submit", draft.ID), map[string]any{
		"title":       fmt.Sprintf("Release candidate: %s %s", rc.Product, rc.Release),
		"description": fmt.Sprintf("Requested by %s in Software Gateway for %s %s.", rc.RequestedBy, rc.Product, rc.Release),
		"reference":   rc.ID,
		"category":    "release",
	})
	if rec.Code >= 300 {
		return nil, fmt.Errorf("submitting: %s", strings.TrimSpace(rec.Body.String()))
	}
	var cr change.ChangeRequest
	if err := json.Unmarshal(rec.Body.Bytes(), &cr); err != nil {
		return nil, fmt.Errorf("submitting: %w", err)
	}
	return &cr, nil
}

func (c *candidateRunner) applicationFor(url string) (string, bool) {
	want := normalizeRemote(url)
	for _, e := range c.hub.registry.List() {
		if normalizeRemote(e.Origin) == want {
			return e.ID, true
		}
	}
	return "", false
}

// normalizeRemote makes https://Host/org/repo.git and https://host/org/repo/
// the same repository.
func normalizeRemote(url string) string {
	u := strings.ToLower(strings.TrimSpace(gitengine.Redact(url)))
	u = strings.TrimSuffix(strings.TrimSuffix(u, "/"), ".git")
	return u
}

// pgCandidates is the queue in Software Gateway's table. Qualified with
// `public`: ArtiAuto's own tables are on its search_path, this one is not.
type pgCandidates struct{ db *sql.DB }

func (q pgCandidates) Claim(ctx context.Context, worker string) (plugin.ReleaseCandidate, bool, error) {
	var rc plugin.ReleaseCandidate
	err := q.db.QueryRowContext(ctx, `
		UPDATE public.release_candidates
		   SET state = 'claimed', claimed_by = $1, claimed_at = now()
		 WHERE id = (
		       SELECT id FROM public.release_candidates
		        WHERE state = 'queued'
		           OR (state = 'waiting' AND claimed_at < now() - interval '10 minutes')
		        ORDER BY requested_at
		        FOR UPDATE SKIP LOCKED
		        LIMIT 1)
		RETURNING id::text, product_name, release_name, stage, git_url, git_branch, git_path, requested_by`,
		worker,
	).Scan(&rc.ID, &rc.Product, &rc.Release, &rc.Stage, &rc.GitURL, &rc.GitBranch, &rc.GitPath, &rc.RequestedBy)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return rc, false, nil
	case err != nil && strings.Contains(err.Error(), "release_candidates"):
		// Software Gateway has not migrated this database (yet): nothing asked.
		return rc, false, nil
	case err != nil:
		return rc, false, err
	}
	return rc, true, nil
}

func (q pgCandidates) Settle(ctx context.Context, id, state, resultURL, detail string) error {
	finished := state == candidateSucceeded || state == candidateFailed
	_, err := q.db.ExecContext(ctx, `
		UPDATE public.release_candidates
		   SET state = $2, result_url = $3, detail = $4,
		       finished_at = CASE WHEN $5 THEN now() ELSE NULL END
		 WHERE id = $1::uuid`, id, state, resultURL, detail, finished)
	return err
}
