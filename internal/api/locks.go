package api

// The two write locks, and why there are two.
//
// There used to be one mutex per application, held by every write path there
// is. It was correct and it was also the ceiling on how many people could use
// one application at once: staging a cell edit - a few hundred microseconds of
// JSON bookkeeping that touches no repository file at all - queued behind
// whatever else was running, including a submit, which holds its lock across a
// network push and a pull-request call. One person publishing a change stalled
// everyone else's typing for as long as GitHub took to answer.
//
// The two locks separate the two things that were being conflated:
//
//   - treeMu guards the working tree and the git plumbing over it: catalog
//     commits into .configer, the sync fast-forward, merges, submit, reject.
//     These stay mutually exclusive, deliberately. Git is perfectly capable of
//     handling concurrent plumbing, but "probably safe" is not the standard for
//     the thing that owns the user's repository, and none of these paths are
//     what people do all day.
//   - a per-owner draft lock guards read-modify-write sequences on the
//     change-request store: open the author's draft, upsert an item, read the
//     new count. That IS what people do all day, from several sessions at once.
//     Drafts are already scoped per owner, so the lock is too: two people
//     editing different drafts never meet, and neither waits on a colleague's
//     change being pushed.
//
// A handler needing both takes treeMu first, then the draft lock. Retiring a
// parameter is one that does (it edits .configer and drops the parameter's
// pending items from the caller's draft); so is submitting, which must hold its
// author's draft still while it reads the items it is about to commit.

import (
	"sync"
	"sync/atomic"
)

// treeLock is the working-tree lock. Releasing it bumps a generation counter,
// which is how the read cache learns that the files it parsed may have moved
// underneath it (see treecache.go).
//
// Counting on release rather than at each write site is the point: every path
// that changes the tree already brackets itself with this lock, so invalidation
// is a property of the lock instead of a rule someone has to remember. It
// over-counts - a handler that took the lock and then failed validation bumps
// it too - and that is the right direction to be wrong in. The cost is one
// re-parse that was not strictly necessary; the alternative failure is serving
// a value the repository no longer holds.
type treeLock struct {
	mu  sync.Mutex
	gen atomic.Uint64
}

func (l *treeLock) Lock() { l.mu.Lock() }

func (l *treeLock) Unlock() {
	l.gen.Add(1)
	l.mu.Unlock()
}

// Gen is the current write generation. A reader takes it once, at the top of
// the request, and reads everything at that generation.
func (l *treeLock) Gen() uint64 { return l.gen.Load() }

// draftLocks hands out one mutex per draft owner.
//
// A single store-wide mutex would be correct, and would also put every editor
// in the application back in one queue - the thing this whole split exists to
// undo. Ownership is the natural boundary because the store already draws it:
// a draft belongs to exactly one author, and only that author's own requests
// read-modify-write it.
//
// The map only ever grows, bounded by the number of people who have edited this
// application since the process started. That is a mutex each, and they are
// deliberately never reclaimed: a lock that can be collected while someone is
// queued on it is a race, and the memory at stake is nothing.
type draftLocks struct {
	mu sync.Mutex
	m  map[string]*sync.Mutex
}

// lock takes the owner's draft lock and returns the function that releases it,
// so a caller reads `defer s.lockDraft(owner)()`.
func (d *draftLocks) lock(owner string) func() {
	d.mu.Lock()
	if d.m == nil {
		d.m = map[string]*sync.Mutex{}
	}
	m, ok := d.m[owner]
	if !ok {
		m = &sync.Mutex{}
		d.m[owner] = m
	}
	d.mu.Unlock()

	m.Lock()
	return m.Unlock
}
