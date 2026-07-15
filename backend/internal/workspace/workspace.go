// Package workspace persists the multi-repository registry: which Git
// repositories this Configer server manages, where their working trees live,
// and how they were connected. The registry is operational state (like the
// change-request store), never configuration truth; each repository remains
// its own source of truth and can be re-connected from scratch at any time.
package workspace

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Entry is one connected repository.
type Entry struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Origin string `json:"origin"` // git URL, or the local path when Local
	Path   string `json:"path"`   // working tree on this server
	Branch string `json:"branch,omitempty"`
	// Local means the repository was opened in place (a path on this
	// machine) rather than cloned into the data directory.
	Local bool `json:"local,omitempty"`
	// Remote means the repository is managed entirely through the Git data
	// API with no clone: Path is a materialized read cache, not a git tree.
	Remote bool `json:"remote,omitempty"`
	// Token is the access token for a Remote repository, persisted (0600)
	// like a clone's embedded credential so API calls survive restarts. It
	// is never included in any API response.
	Token   string    `json:"token,omitempty"`
	AddedAt time.Time `json:"addedAt"`
}

// Registry is the persisted list of connected repositories.
type Registry struct {
	mu      sync.Mutex
	file    string
	entries []Entry
}

// Load reads (or initializes) the registry stored under dataDir.
func Load(dataDir string) (*Registry, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	reg := &Registry{file: filepath.Join(dataDir, "workspace.json")}
	b, err := os.ReadFile(reg.file)
	if err != nil {
		if os.IsNotExist(err) {
			return reg, nil
		}
		return nil, err
	}
	var doc struct {
		Repos []Entry `json:"repos"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		return nil, fmt.Errorf("parse %s: %w", reg.file, err)
	}
	reg.entries = doc.Repos
	return reg, nil
}

func (r *Registry) save() error {
	doc := struct {
		Repos []Entry `json:"repos"`
	}{Repos: r.entries}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	tmp := r.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, r.file)
}

// List returns the entries in connection order (first = default repository).
func (r *Registry) List() []Entry {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Entry, len(r.entries))
	copy(out, r.entries)
	return out
}

// Get looks an entry up by id.
func (r *Registry) Get(id string) (Entry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.entries {
		if e.ID == id {
			return e, true
		}
	}
	return Entry{}, false
}

// Add appends and persists a new entry; the id must be unique.
func (r *Registry) Add(e Entry) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, x := range r.entries {
		if x.ID == e.ID {
			return fmt.Errorf("repository id %q already exists", e.ID)
		}
	}
	r.entries = append(r.entries, e)
	return r.save()
}

// Remove deletes an entry and persists; returns the removed entry.
func (r *Registry) Remove(id string) (Entry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, e := range r.entries {
		if e.ID == id {
			r.entries = append(r.entries[:i], r.entries[i+1:]...)
			_ = r.save()
			return e, true
		}
	}
	return Entry{}, false
}

// Rename changes an entry's display name (its id stays stable, so deep links
// and per-repo routes keep working) and persists.
func (r *Registry) Rename(id, name string) (Entry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.entries {
		if r.entries[i].ID == id {
			r.entries[i].Name = name
			_ = r.save()
			return r.entries[i], true
		}
	}
	return Entry{}, false
}

// UniqueID derives an unused registry id from a base slug.
func (r *Registry) UniqueID(base string) string {
	if base == "" {
		base = "repo"
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	used := map[string]bool{}
	for _, e := range r.entries {
		used[e.ID] = true
	}
	if !used[base] {
		return base
	}
	for n := 2; ; n++ {
		id := fmt.Sprintf("%s-%d", base, n)
		if !used[id] {
			return id
		}
	}
}

// Slug normalizes a display name into a URL-safe id.
func Slug(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = strings.Map(func(c rune) rune {
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
			return c
		default:
			return '-'
		}
	}, s)
	parts := strings.FieldsFunc(s, func(c rune) bool { return c == '-' })
	return strings.Join(parts, "-")
}

// NameFromURL derives a human-friendly repository name from a git URL or
// filesystem path (the last path segment without a .git suffix). Windows
// paths use backslashes and a drive letter ("C:\Users\me\project"), so those
// are normalized first — otherwise the whole path after "C:" would be taken
// as the name.
func NameFromURL(url string) string {
	s := strings.ReplaceAll(strings.TrimSpace(url), "\\", "/")
	s = strings.TrimSuffix(strings.TrimRight(s, "/"), ".git")
	if i := strings.LastIndexAny(s, "/:"); i >= 0 {
		s = s[i+1:]
	}
	if s == "" {
		return "repository"
	}
	return s
}
