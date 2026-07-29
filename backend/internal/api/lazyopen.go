package api

// Opening applications on first use rather than at startup.
//
// The hub used to open every registered application inside NewHub, which meant
// the process did not finish starting until every repository had been cloned.
// Fifty applications was fifty clones before the service answered anything, and
// in a container that turns a restart into minutes of downtime and makes the
// working copies something the deployment has to keep on a disk that survives -
// not because the data matters (it is all reconstructible from the origin) but
// because re-fetching it was on the critical path to being alive at all.
//
// Opening on demand takes that off the critical path. The process is ready
// immediately; the first request that actually needs an application pays for
// that one application, once. A background warmer then opens the rest at its
// own pace, so the portfolio fills in shortly after start without anything
// waiting on it.
//
// The working copy becomes exactly what it should have been all along: a cache.
// Present, and startup is instant. Absent, and it is rebuilt on use.

import (
	"log/slog"
	"sync"
	"time"
)

// openRetryAfter is how long a failed open is remembered before another request
// may try again. Without it, an application whose origin is unreachable would
// re-clone on every single request, and each attempt costs a network timeout;
// with it the failure is reported instantly from the recorded reason and retried
// occasionally, which is what someone waiting for a network to come back wants.
const openRetryAfter = 30 * time.Second

// warmConcurrency is how many applications the background warmer opens at once.
// Higher is not better: these are network fetches sharing one uplink, and the
// point of warming is to be finished before anybody notices, not to saturate the
// link while real requests are being served.
const warmConcurrency = 4

// openFailure records why an application could not be opened, and when, so the
// portfolio can say so without retrying on every read.
type openFailure struct {
	reason string
	at     time.Time
}

// keyedLocks hands out one mutex per key. The map only grows, bounded by the
// number of distinct keys seen; a lock that could be collected while somebody
// is queued on it would be a race, and the memory at stake is nothing.
type keyedLocks struct {
	mu sync.Mutex
	m  map[string]*sync.Mutex
}

// lock takes the key's mutex and returns the function that releases it, so a
// caller reads `defer l.lock(k)()`.
func (l *keyedLocks) lock(key string) func() {
	l.mu.Lock()
	if l.m == nil {
		l.m = map[string]*sync.Mutex{}
	}
	m, ok := l.m[key]
	if !ok {
		m = &sync.Mutex{}
		l.m[key] = m
	}
	l.mu.Unlock()

	m.Lock()
	return m.Unlock
}

// opened reports whether an application is already serving, without opening it.
// The portfolio uses this: listing applications must never be the thing that
// clones fifty repositories.
func (h *Hub) opened(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.handlers[id]
	return ok
}

// openState describes an application that is not currently serving: the reason
// it failed, or "" when it simply has not been opened yet.
func (h *Hub) openState(id string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if f, ok := h.openErrs[id]; ok {
		return f.reason
	}
	return ""
}

// ensureOpen opens an application if it is not already serving, and reports
// whether it is serving afterwards.
//
// It is single-flight per application: two requests arriving together for a
// repository that is not open yet produce ONE clone, not two racing into the
// same directory.
func (h *Hub) ensureOpen(id string) bool {
	if h.opened(id) {
		return true
	}
	e, known := h.registry.Get(id)
	if !known {
		return false
	}

	defer h.opens.lock(id)()
	// Somebody else may have opened it while this call waited for the lock.
	if h.opened(id) {
		return true
	}
	// A recent failure is reported from the record rather than retried, so a
	// broken origin costs one timeout every openRetryAfter, not one per request.
	h.mu.Lock()
	if f, failed := h.openErrs[id]; failed && time.Since(f.at) < openRetryAfter {
		h.mu.Unlock()
		return false
	}
	h.mu.Unlock()

	started := time.Now()
	if err := h.open(e); err != nil {
		h.mu.Lock()
		h.openErrs[id] = openFailure{reason: err.Error(), at: time.Now()}
		h.errs[id] = err.Error()
		h.mu.Unlock()
		slog.Warn("could not open application on demand",
			slog.String("id", id), slog.Any("error", err))
		return false
	}
	h.mu.Lock()
	delete(h.openErrs, id)
	h.mu.Unlock()
	slog.Info("opened application on demand",
		slog.String("id", id), slog.Duration("took", time.Since(started)))
	h.enqueueReindex(id)
	return true
}

// warmAll opens every registered application in the background.
//
// Nothing waits on this. It exists so the portfolio shows real numbers shortly
// after a restart instead of only for applications somebody has visited, and so
// the first person to open an application usually finds it already warm. If it
// is still running when a request arrives, ensureOpen's per-application lock
// means the request joins the warm-up rather than starting a second one.
func (h *Hub) warmAll() {
	entries := h.registry.List()
	if len(entries) == 0 {
		return
	}
	slog.Info("warming applications in the background", slog.Int("count", len(entries)))
	ids := make(chan string)
	var wg sync.WaitGroup
	for i := 0; i < warmConcurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for id := range ids {
				h.ensureOpen(id)
			}
		}()
	}
	for _, e := range entries {
		ids <- e.ID
	}
	close(ids)
	wg.Wait()
	slog.Info("finished warming applications")
}
