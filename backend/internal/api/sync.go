package api

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// RepoStatus is the git-liveness snapshot shown in the UI: Configer's tree vs
// the origin remote. Git remains the source of truth; when someone commits
// directly on GitHub, the poller fast-forwards the tree and every grid read
// reflects it. Configer streamlines Git; it never gates it.
type RepoStatus struct {
	Branch     string    `json:"branch"`
	Remote     string    `json:"remote,omitempty"`
	Ahead      int       `json:"ahead"`
	Behind     int       `json:"behind"`
	LastSync   time.Time `json:"lastSync,omitempty"`
	SyncError  string    `json:"syncError,omitempty"`
	Provider   string    `json:"provider,omitempty"`
	AutoSyncMs int       `json:"autoSyncMs,omitempty"`
	// UpstreamGone means the branch's remote counterpart was deleted (e.g.
	// someone removed the branch on GitHub). Local work continues safely;
	// the UI explains and suggests choosing a new target branch.
	UpstreamGone bool `json:"upstreamGone,omitempty"`
}

type syncState struct {
	mu     sync.Mutex
	status RepoStatus
}

// StartSyncLoop begins polling the remote every interval, fast-forwarding the
// working tree / refreshing the read cache when external commits land, so they
// appear in the UI without any user action. No-op when the backend cannot
// publish (a pure-local repo with no remote).
func (s *Server) StartSyncLoop(interval time.Duration) {
	if !s.Backend.CanPublish() || interval <= 0 {
		return
	}
	s.sync.mu.Lock()
	s.sync.status.AutoSyncMs = int(interval.Milliseconds())
	s.sync.mu.Unlock()
	stop := make(chan struct{})
	s.syncStop = stop
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				s.syncOnce()
			case <-stop:
				return
			}
		}
	}()
}

// StopSync ends the polling loop (used when a repository is disconnected
// from the workspace).
func (s *Server) StopSync() {
	if s.syncStop != nil {
		close(s.syncStop)
		s.syncStop = nil
	}
}

// Status returns the last computed git-liveness snapshot (computing it on
// first use).
func (s *Server) Status() RepoStatus {
	s.sync.mu.Lock()
	st := s.sync.status
	s.sync.mu.Unlock()
	if st.LastSync.IsZero() {
		st = s.syncOnce()
	}
	return st
}

// syncOnce delegates to the backend: locally it fetches origin and
// fast-forwards; remotely it refreshes the materialized cache via the compare
// API. Either way external commits become visible without user action.
func (s *Server) syncOnce() RepoStatus {
	branch := s.branch()
	st := RepoStatus{Branch: branch, Remote: s.Backend.Origin()}
	if prov := s.Backend.Provider(); prov != nil {
		st.Provider = prov.Name()
	}

	s.writeMu.Lock()
	res, _ := s.Backend.Sync(context.Background(), branch)
	s.writeMu.Unlock()
	st.Ahead, st.Behind = res.Ahead, res.Behind
	st.UpstreamGone = res.UpstreamGone
	st.SyncError = res.SyncError
	st.LastSync = time.Now().UTC()

	s.sync.mu.Lock()
	if st.AutoSyncMs == 0 {
		st.AutoSyncMs = s.sync.status.AutoSyncMs
	}
	s.sync.status = st
	s.sync.mu.Unlock()
	return st
}

// repoStatus returns the git-liveness snapshot.
//
// @Summary     Git status
// @Description The git-liveness snapshot: branch, remote, ahead/behind counts, last sync time, and any sync error.
// @Tags        Import & reconcile
// @Produce     json
// @Success     200 {object} RepoStatus
// @Router      /api/repo/status [get]
func (s *Server) repoStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Status())
}

// repoSync forces a sync with the remote now.
//
// @Summary     Force a sync
// @Description Force a fetch + fast-forward (local) or cache refresh (remote) now, instead of waiting for the poll interval, and return the fresh status.
// @Tags        Import & reconcile
// @Produce     json
// @Success     200 {object} RepoStatus
// @Security    CookieSession
// @Router      /api/repo/sync [post]
func (s *Server) repoSync(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.syncOnce())
}
