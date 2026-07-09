package api

import (
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// RepoStatus is the git-liveness snapshot shown in the UI: Configer's tree vs
// the origin remote. Git remains the source of truth — when someone commits
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
}

type syncState struct {
	mu     sync.Mutex
	status RepoStatus
}

// StartSyncLoop begins polling origin every interval, fast-forwarding the
// working tree when it is strictly behind (external commits land in the UI
// without any user action). No-op when the repo has no remote.
func (s *Server) StartSyncLoop(interval time.Duration) {
	if !s.Git.HasRemote() || interval <= 0 {
		return
	}
	s.sync.mu.Lock()
	s.sync.status.AutoSyncMs = int(interval.Milliseconds())
	s.sync.mu.Unlock()
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for range t.C {
			s.syncOnce()
		}
	}()
}

// syncOnce fetches origin and fast-forwards when safely possible.
func (s *Server) syncOnce() RepoStatus {
	st := RepoStatus{Remote: s.Git.OriginURL()}
	branch, err := s.Git.CurrentBranch()
	if err == nil {
		st.Branch = branch
	}
	if s.Changes != nil && s.Changes.Provider != nil {
		st.Provider = s.Changes.Provider.Name()
	}

	if s.Git.HasRemote() {
		if err := s.Git.Fetch(); err != nil {
			st.SyncError = err.Error()
		} else if ahead, behind, err := s.Git.AheadBehind(branch); err == nil {
			st.Ahead, st.Behind = ahead, behind
			if behind > 0 && ahead == 0 {
				// External commits only: fast-forward so the grid goes live.
				s.writeMu.Lock()
				if err := s.Git.Pull(branch); err != nil {
					st.SyncError = err.Error()
				} else {
					st.Behind = 0
					log.Printf("synced %d external commit(s) from origin/%s", behind, branch)
				}
				s.writeMu.Unlock()
			}
		} else {
			st.SyncError = err.Error()
		}
	}
	st.LastSync = time.Now().UTC()

	s.sync.mu.Lock()
	if st.AutoSyncMs == 0 {
		st.AutoSyncMs = s.sync.status.AutoSyncMs
	}
	s.sync.status = st
	s.sync.mu.Unlock()
	return st
}

func (s *Server) repoStatus(w http.ResponseWriter, _ *http.Request) {
	s.sync.mu.Lock()
	st := s.sync.status
	s.sync.mu.Unlock()
	if st.LastSync.IsZero() {
		// first call before any poll: compute lazily
		st = s.syncOnce()
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) repoSync(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.syncOnce())
}

// SyncIntervalFromEnv reads CONFIGER_SYNC_SECONDS (default 30, 0 disables).
func SyncIntervalFromEnv() time.Duration {
	sec := 30
	if v := getenv("CONFIGER_SYNC_SECONDS", ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			sec = n
		}
	}
	return time.Duration(sec) * time.Second
}
