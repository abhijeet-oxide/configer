package api

// Read-path memoization for the working tree.
//
// Every repo-scoped read used to start from nothing: project.Load re-parsed
// the five .configer files, and the resolver re-read and re-parsed every bound
// configuration file in the repository. A grid over a few hundred instances is
// a few hundred YAML parses, and it paid that bill again for every request,
// from every user, whether or not a single byte had changed since the last one.
// With several people in one application it multiplied by the number of them.
//
// A parsed file is a pure function of its bytes, so it is memoizable; the only
// question is how to know the bytes changed. Two signals answer it together:
//
//   - The file's own stamp (modification time + size), checked on every read.
//     A stat is roughly three orders of magnitude cheaper than a parse, so
//     validating is nearly free while the saving is the whole parse. This is
//     what keeps an edit made outside Configer - an operator pulling in the
//     working copy, a developer editing the repository `make dev` serves -
//     visible immediately, exactly as it was before any of this existed.
//   - The write generation, bumped whenever the working-tree lock is released
//     (see treeLock). Configer's own writes therefore drop the cache outright
//     rather than relying on stamps, which matters on a filesystem whose
//     modification times are coarse: a one-character value edit can leave both
//     the size and a whole-second mtime unchanged.
//
// The result is a cache with no invalidation protocol to get wrong. Nothing
// has to remember to call it; correctness comes from the file itself.

import (
	"os"
	"path/filepath"
	"sync"

	"github.com/abhijeet-oxide/configer/backend/internal/pathedit"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// configerFiles are the metadata files project.Load reads. Stamping them is
// what tells a cached Project from a stale one.
// regions.yaml is here because project.Load reads it too: it decides the order
// every instance list comes out in, so a repository that adds a site to it must
// see its estate re-order without waiting for something else to change.
var configerFiles = []string{
	"application.yaml", "parameters.yaml", "instances.yaml", "sources.yaml", "ignore.yaml",
	"regions.yaml",
}

// stamp is a file's identity for caching purposes. A missing file stamps as
// the zero value, which differs from any real file and so reads as a change
// when one appears (or disappears).
type stamp struct {
	modUnixNano int64
	size        int64
}

func stampOf(path string) stamp {
	fi, err := os.Stat(path)
	if err != nil {
		return stamp{}
	}
	return stamp{modUnixNano: fi.ModTime().UnixNano(), size: fi.Size()}
}

// docEntry is one cached parsed file. Its own mutex means two readers of
// DIFFERENT files never wait on each other, while two readers of the same
// file share one parse instead of doing it twice.
type docEntry struct {
	mu     sync.Mutex
	loaded bool
	stamp  stamp
	doc    *pathedit.Document
}

// treeCache memoizes the parsed form of one repository root.
type treeCache struct {
	root string

	mu   sync.Mutex
	gen  uint64 // write generation these entries belong to
	docs map[string]*docEntry

	projMu     sync.Mutex
	projGen    uint64
	proj       *project.Project
	projStamps map[string]stamp
}

func newTreeCache(root string) *treeCache {
	return &treeCache{root: root, docs: map[string]*docEntry{}}
}

// entry returns the cache slot for a file, discarding everything cached under
// an older write generation first.
//
// The comparison is strictly forward. A request that started before a write
// carries the older generation, and it will still be asking for files while
// newer requests are being served: resetting on ANY difference made those two
// clear each other's work on every single lookup, and the cache held nothing
// for as long as one write and one slow reader overlapped. Serving the newer
// entries to the older request is correct regardless, because what actually
// decides whether an entry may be reused is the file's own stamp, checked
// below on every read.
func (c *treeCache) entry(gen uint64, file string) *docEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	if gen > c.gen {
		c.gen = gen
		c.docs = map[string]*docEntry{}
	}
	e, ok := c.docs[file]
	if !ok {
		e = &docEntry{}
		c.docs[file] = e
	}
	return e
}

// docsAt returns a resolver.Docs view of this cache pinned to one write
// generation, so a single request reads a consistent tree even if a write
// lands while it is being served.
func (c *treeCache) docsAt(gen uint64) *treeDocs { return &treeDocs{cache: c, gen: gen} }

// treeDocs adapts treeCache to resolver.Docs at a fixed generation.
type treeDocs struct {
	cache *treeCache
	gen   uint64
}

// Doc returns the parsed document for a repo-relative file, parsing it only
// when the file has changed since it was last parsed.
func (d *treeDocs) Doc(file, format string) *pathedit.Document {
	e := d.cache.entry(d.gen, file)
	full := filepath.Join(d.cache.root, file)

	e.mu.Lock()
	defer e.mu.Unlock()
	st := stampOf(full)
	if e.loaded && e.stamp == st {
		return e.doc
	}
	var doc *pathedit.Document
	if b, err := os.ReadFile(full); err == nil {
		// A parse error caches a nil document, exactly as the uncached path
		// did: an unreadable file supplies no value, and re-reading it on
		// every cell lookup would only cost more to learn the same thing.
		doc, _ = pathedit.Parse(b, format)
	}
	e.loaded, e.stamp, e.doc = true, st, doc
	return doc
}

// Project returns the loaded project, reusing the previous load while none of
// the .configer files have changed.
//
// The returned Project is SHARED by every concurrent reader and must be treated
// as read-only. That is what the read paths already do (they resolve, filter
// and render from it; nothing writes back through it), and .configer itself is
// only ever changed by the writer package, which edits the files on disk - so
// the next call here re-reads them.
func (c *treeCache) Project(gen uint64) (*project.Project, error) {
	c.projMu.Lock()
	defer c.projMu.Unlock()

	stamps := make(map[string]stamp, len(configerFiles))
	for _, f := range configerFiles {
		stamps[f] = stampOf(filepath.Join(c.root, ".configer", f))
	}
	// As in entry: a cache built at a NEWER generation is fine to serve to an
	// older request, and only a forward step discards anything.
	if c.proj != nil && c.projGen >= gen && sameStamps(c.projStamps, stamps) {
		return c.proj, nil
	}
	p, err := project.Load(c.root)
	if err != nil {
		return nil, err
	}
	if gen < c.projGen {
		gen = c.projGen
	}
	c.proj, c.projStamps, c.projGen = p, stamps, gen
	return p, nil
}

func sameStamps(a, b map[string]stamp) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}
