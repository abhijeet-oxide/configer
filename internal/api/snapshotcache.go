package api

// Snapshot memoization for the timeline.
//
// Reading one timeline entry means materializing a commit and resolving every
// parameter on every instance at it. Doing that per request made the default
// view (all instances, 20 snapshots) cost 21 full repository checkouts and 21
// full configuration resolutions to produce a few kilobytes of summary, every
// single time the tab was opened.
//
// A commit is immutable, so the state at (sha, scope) is a pure function of an
// object that can never change: it is memoizable without any invalidation
// question. The first load pays for the window; every later load pays only for
// commits it has not seen, and opening a snapshot reuses what the list already
// computed instead of walking the history a second time.
//
// The cache is bounded by entry count rather than bytes, which is the honest
// trade: an entry is roughly one string per set cell, so a large estate holds
// larger entries. snapshotCacheMax is sized to cover a full timeline window
// plus a scope switch, not to be a general-purpose store.

import (
	"container/list"
	"runtime"
	"sync"
)

// snapshotCacheMax is how many (commit, scope) states are kept. A timeline
// window is limit+1 (max 41), so this holds a full window plus room for the
// scope the user switches to and back from.
const snapshotCacheMax = 64

// snapshotCache is a mutex-guarded LRU. It is small and read-mostly, so a plain
// mutex is cheaper and clearer than anything striped.
type snapshotCache struct {
	mu    sync.Mutex
	max   int
	ll    *list.List // front = most recently used
	items map[string]*list.Element
}

type snapshotEntry struct {
	key   string
	state snapshotState
}

func newSnapshotCache(max int) *snapshotCache {
	return &snapshotCache{max: max, ll: list.New(), items: map[string]*list.Element{}}
}

func (c *snapshotCache) get(key string) (snapshotState, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.items[key]
	if !ok {
		return snapshotState{}, false
	}
	c.ll.MoveToFront(el)
	return el.Value.(*snapshotEntry).state, true
}

func (c *snapshotCache) put(key string, st snapshotState) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		el.Value.(*snapshotEntry).state = st
		c.ll.MoveToFront(el)
		return
	}
	c.items[key] = c.ll.PushFront(&snapshotEntry{key: key, state: st})
	for c.ll.Len() > c.max {
		oldest := c.ll.Back()
		if oldest == nil {
			break
		}
		c.ll.Remove(oldest)
		delete(c.items, oldest.Value.(*snapshotEntry).key)
	}
}

// timelineStateKey identifies a state: the commit plus the scope it was read in
// (a scoped read only carries one instance's cells, so the two are not
// interchangeable).
func timelineStateKey(sha, instance string) string { return sha + "|" + instance }

// snapshotAt returns the configuration state at one commit, from the cache when
// it is there and by materializing the commit when it is not. A commit that
// cannot be materialized reports false rather than failing the whole request:
// one unreadable snapshot should cost its own dot, not the timeline.
func (s *Server) snapshotAt(sha, instance string) (snapshotState, bool) {
	key := timelineStateKey(sha, instance)
	if st, ok := s.snapshots.get(key); ok {
		return st, true
	}
	p, cleanup, err := s.projectAtRef(sha)
	if err != nil {
		return snapshotState{}, false
	}
	st := readSnapshot(p, instance)
	cleanup()
	s.snapshots.put(key, st)
	return st, true
}

// snapshotWorkers bounds how many commits are materialized at once. Each worker
// holds its own detached worktree while it reads, so this caps both the CPU in
// flight and the disk a timeline request can occupy at any moment.
func snapshotWorkers(n int) int {
	w := runtime.NumCPU()
	if w > 4 {
		w = 4
	}
	if w > n {
		w = n
	}
	if w < 1 {
		w = 1
	}
	return w
}

// snapshotsAt resolves several commits, reading the cache first and computing
// the rest in parallel. The per-commit work is independent (each materializes
// its own worktree), so the wall time of a cold timeline drops to roughly the
// slowest worker's share instead of the sum.
func (s *Server) snapshotsAt(shas []string, instance string) map[string]snapshotState {
	out := make(map[string]snapshotState, len(shas))
	missing := make([]string, 0, len(shas))
	for _, sha := range shas {
		if st, ok := s.snapshots.get(timelineStateKey(sha, instance)); ok {
			out[sha] = st
			continue
		}
		missing = append(missing, sha)
	}
	if len(missing) == 0 {
		return out
	}

	type result struct {
		sha   string
		state snapshotState
		ok    bool
	}
	jobs := make(chan string)
	results := make(chan result, len(missing))
	var wg sync.WaitGroup
	for i := 0; i < snapshotWorkers(len(missing)); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for sha := range jobs {
				st, ok := s.snapshotAt(sha, instance)
				results <- result{sha: sha, state: st, ok: ok}
			}
		}()
	}
	for _, sha := range missing {
		jobs <- sha
	}
	close(jobs)
	wg.Wait()
	close(results)
	for r := range results {
		if r.ok {
			out[r.sha] = r.state
		}
	}
	return out
}
