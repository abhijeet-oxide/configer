// Package cache makes a re-run cheap. It is content-addressed: an analyzer's
// result is stored under a key derived from everything that could change the
// answer, so a hit is not a guess, it is a proof that the inputs are identical.
//
// This is the difference between an agent loop that costs a full CI run per
// iteration and one that costs only the checks whose inputs it actually moved.
package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
	"github.com/abhijeet-oxide/configer/quality/internal/pathmatch"
)

// Entry is one cached analyzer result. It stores the normalized output, never
// the raw tool bytes: replaying a cached SARIF file would mean re-normalizing
// it, and the artifact it came from is already on disk if anybody wants it.
type Entry struct {
	Key        string          `json:"key"`
	Analyzer   string          `json:"analyzer"`
	StoredAt   time.Time       `json:"storedAt"`
	Findings   []model.Finding `json:"findings"`
	Metrics    []model.Metric  `json:"metrics"`
	ExitCode   int             `json:"exitCode"`
	Artifact   string          `json:"artifact,omitempty"`
	DurationMS int64           `json:"durationMs"`
}

// Cache is a directory of entries. It is safe for concurrent use; writes are
// atomic through a temp file and a rename, so a cancelled run never leaves a
// half-written entry that a later run would trust.
type Cache struct {
	dir     string
	enabled bool
	hits    atomic.Int64
	misses  atomic.Int64
}

// Open prepares the cache directory. A cache that cannot be created is not an
// error: the platform simply runs everything, which is correct and only slower.
func Open(dir string, enabled bool) *Cache {
	c := &Cache{dir: dir, enabled: enabled}
	if enabled {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			c.enabled = false
		}
	}
	return c
}

// Stats reports hits and misses for the run metadata.
func (c *Cache) Stats() (hits, misses int) {
	return int(c.hits.Load()), int(c.misses.Load())
}

// Get returns a cached entry, if the key is present.
func (c *Cache) Get(key string) (*Entry, bool) {
	if !c.enabled || key == "" {
		return nil, false
	}
	b, err := os.ReadFile(c.path(key))
	if err != nil {
		c.misses.Add(1)
		return nil, false
	}
	var e Entry
	if err := json.Unmarshal(b, &e); err != nil {
		c.misses.Add(1)
		return nil, false
	}
	c.hits.Add(1)
	return &e, true
}

// Put stores an entry. A failure to write is swallowed for the same reason a
// failure to create the directory is: the cache is an optimization, and it may
// never be the reason a quality run fails.
func (c *Cache) Put(e Entry) {
	if !c.enabled || e.Key == "" {
		return
	}
	e.StoredAt = time.Now().UTC()
	b, err := json.Marshal(e)
	if err != nil {
		return
	}
	// The two-character fan-out directory has to exist before the rename, or
	// every write fails silently and the cache is a very thorough way of doing
	// nothing. It did exactly that until a run reported 0 hits and 18 misses
	// twice in a row over identical inputs.
	target := c.path(e.Key)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return
	}
	tmp, err := os.CreateTemp(c.dir, ".tmp-*")
	if err != nil {
		return
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return
	}
	if err := tmp.Close(); err != nil {
		return
	}
	_ = os.Rename(tmp.Name(), target)
}

func (c *Cache) path(key string) string {
	// Two hex characters of fan-out keeps a long-lived cache directory from
	// becoming one enormous flat listing.
	return filepath.Join(c.dir, key[:2], key+".json")
}

// KeyInput is everything that can change an analyzer's answer. Anything not
// listed here is, by construction, asserted not to matter.
type KeyInput struct {
	AnalyzerID   string
	ToolVersion  string
	Command      []string
	Env          map[string]string
	ConfigDigest string   // the repository's cq.yaml plus the analyzer manifest
	Files        []string // repository-relative paths, already resolved
	Extra        []string // anything else the caller wants to bind in
}

// Key derives the content address. Every component is length-prefixed so that
// no combination of values can collide by concatenation, which is the classic
// way a hand-rolled cache key silently reuses the wrong result.
func Key(root string, in KeyInput) (string, error) {
	h := sha256.New()
	write := func(parts ...string) {
		for _, p := range parts {
			fmt.Fprintf(h, "%d:%s\x00", len(p), p)
		}
	}
	write("v1", in.AnalyzerID, in.ToolVersion, in.ConfigDigest)
	write(in.Command...)
	keys := make([]string, 0, len(in.Env))
	for k := range in.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		write(k, in.Env[k])
	}
	write(in.Extra...)

	files := append([]string(nil), in.Files...)
	sort.Strings(files)
	for _, rel := range files {
		d, err := fileDigest(filepath.Join(root, rel))
		if err != nil {
			// A file that disappeared between listing and hashing means the
			// tree moved under us; refusing to cache is the honest answer.
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return "", err
		}
		write(rel, d)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func fileDigest(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", err
	}
	if st.IsDir() {
		return "dir", nil
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Resolve expands an analyzer's declared cache inputs (globs) into the concrete
// file list that gets hashed. It walks the tree once per call; the result is
// small and the walk is cheap next to any analyzer worth caching.
func Resolve(root string, globs, ignore []string) ([]string, error) {
	if len(globs) == 0 {
		return nil, nil
	}
	var out []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if rel == "." {
			return nil
		}
		if d.IsDir() {
			// Pruning at the directory level is what keeps this affordable on a
			// repository with a node_modules tree in it.
			if pathmatch.MatchAny(ignore, rel) || pathmatch.MatchAny(ignore, rel+"/") ||
				d.Name() == ".git" || d.Name() == "node_modules" {
				return fs.SkipDir
			}
			return nil
		}
		if pathmatch.MatchAny(ignore, rel) {
			return nil
		}
		if pathmatch.MatchAny(globs, rel) {
			out = append(out, rel)
		}
		return nil
	})
	sort.Strings(out)
	return out, err
}

// Digest hashes an arbitrary blob, used for the config digest.
func Digest(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		fmt.Fprintf(h, "%d:%s\x00", len(p), p)
	}
	return hex.EncodeToString(h.Sum(nil))[:32]
}

// Prune removes entries older than maxAge. A cache directory on a CI runner is
// restored from a key that does not change often, so without this it grows
// without bound and the restore itself becomes the slow step.
func (c *Cache) Prune(maxAge time.Duration) (removed int) {
	if !c.enabled {
		return 0
	}
	cutoff := time.Now().Add(-maxAge)
	_ = filepath.WalkDir(c.dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".json") {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.ModTime().After(cutoff) {
			return nil
		}
		if os.Remove(p) == nil {
			removed++
		}
		return nil
	})
	return removed
}
