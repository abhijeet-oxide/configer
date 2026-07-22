// Package crstore persists change requests as a JSON file kept under the
// managed repository's .git directory (invisible to git itself). It is the
// deliberately light operational store from the design: Git holds the config
// truth, this holds only workflow state, and Phase 3 swaps it for Postgres
// behind the same interface.
package crstore

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
)

type fileData struct {
	Seq  int                     `json:"seq"`
	CRs  []*change.ChangeRequest `json:"crs"`
	Meta map[string]string       `json:"meta,omitempty"` // small operational KV (e.g. acknowledged reconcile SHA)
}

// Store is a mutex-guarded JSON-file-backed change request store.
type Store struct {
	mu   sync.Mutex
	path string
	data fileData
}

// New loads (or initializes) the store at path.
func New(path string) (*Store, error) {
	s := &Store{path: path}
	b, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(b, &s.data); err != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return s, nil
}

// save persists to disk atomically; caller must hold s.mu. A crash or a
// concurrent reader never observes a half-written file: the state is written to
// a temp file in the same directory and renamed over the target in one step
// (the same discipline workspace.Registry.save uses).
func (s *Store) save() error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".state-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }() // no-op once the rename succeeds
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return err
	}
	return os.Rename(tmpName, s.path)
}

// draftFor returns the author's open draft, or nil. Caller holds s.mu. Drafts
// are scoped by author so two people editing at once never share one pending
// changeset - each accumulates their own, and Submit ships only that author's
// edits under that author's name. In single-user mode there is one author
// ("Local user") and therefore a single shared draft, exactly as before.
func (s *Store) draftFor(author string) *change.ChangeRequest {
	for _, cr := range s.data.CRs {
		if cr.State == change.StateDraft && strings.EqualFold(cr.Author, author) {
			return cr
		}
	}
	return nil
}

// Draft returns the author's draft CR, creating one if none exists.
func (s *Store) Draft(author, targetBranch string) (*change.ChangeRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cr := s.draftFor(author); cr != nil {
		return cr, nil
	}
	s.data.Seq++
	cr := &change.ChangeRequest{
		ID:    s.data.Seq,
		Title: "Draft changes",
		// Every draft rides its own feature branch from the very first edit,
		// so the UI never shows the user editing "on main". The branch is
		// named for real when the change request is submitted.
		Branch:       "feature/unnamed",
		Author:       author,
		TargetBranch: targetBranch,
		State:        change.StateDraft,
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}
	s.data.CRs = append(s.data.CRs, cr)
	return cr, s.save()
}

// CurrentDraft returns the author's draft CR or nil (no lazy creation).
func (s *Store) CurrentDraft(author string) *change.ChangeRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.draftFor(author)
}

// Get returns the CR with the given id.
func (s *Store) Get(id int) (*change.ChangeRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, cr := range s.data.CRs {
		if cr.ID == id {
			return cr, nil
		}
	}
	return nil, fmt.Errorf("change request %d not found", id)
}

// List returns all CRs, newest first.
func (s *Store) List() []*change.ChangeRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*change.ChangeRequest, len(s.data.CRs))
	copy(out, s.data.CRs)
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	return out
}

// Update applies fn to the CR with the given id and persists the result.
func (s *Store) Update(id int, fn func(*change.ChangeRequest) error) (*change.ChangeRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, cr := range s.data.CRs {
		if cr.ID == id {
			if err := fn(cr); err != nil {
				return nil, err
			}
			cr.UpdatedAt = time.Now().UTC()
			return cr, s.save()
		}
	}
	return nil, fmt.Errorf("change request %d not found", id)
}

// GetMeta returns a small operational value ("" when unset).
func (s *Store) GetMeta(key string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.Meta[key]
}

// SetMeta stores a small operational value.
func (s *Store) SetMeta(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Meta == nil {
		s.data.Meta = map[string]string{}
	}
	s.data.Meta[key] = value
	return s.save()
}

// Delete removes the CR with the given id.
func (s *Store) Delete(id int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, cr := range s.data.CRs {
		if cr.ID == id {
			s.data.CRs = append(s.data.CRs[:i], s.data.CRs[i+1:]...)
			return s.save()
		}
	}
	return fmt.Errorf("change request %d not found", id)
}
