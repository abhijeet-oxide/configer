// Package crstore holds change-request WORKFLOW state - who is drafting what,
// which change is under review, who approved it. Git remains the truth for
// configuration itself; nothing here is a value.
//
// Two implementations sit behind one interface. FileStore keeps a JSON file
// under the managed repository's .git directory (invisible to git itself): no
// dependencies, nothing to administer, right for one person on a laptop.
// SQLStore keeps a row per change request in the platform database, which is
// what a deployment with real editors on it needs - a whole-file rewrite per
// keystroke does not survive a busy estate, and a file cannot be shared by two
// processes at all. The api layer chooses between them per deployment (see
// api.crStore); an upgrade carries an existing file's contents across once,
// through SQLStore.Import.
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

// Store is the change-request store contract.
//
// Every method returns change requests that are COPIES. Callers may read and
// modify what they get back freely; nothing they do to it reaches the store
// except through Update, whose callback is applied under the store's own lock.
// That rule is what lets a database implementation exist at all - it cannot
// hand out live pointers - and it was worth having before one did: the file
// store used to return the very objects it kept, so a handler reading a change
// while another mutated it was a data race, and a caller that changed a field
// outside Update either persisted it or did not depending on which method it
// had called.
type Store interface {
	// Draft returns the author's open draft, creating one if none exists.
	Draft(author, targetBranch string) (*change.ChangeRequest, error)
	// CurrentDraft returns the author's open draft, or nil. It never creates.
	CurrentDraft(author string) *change.ChangeRequest
	// Get returns one change request by id.
	Get(id int) (*change.ChangeRequest, error)
	// List returns every change request, newest first.
	List() []*change.ChangeRequest
	// Update applies fn to the stored change request and persists the result.
	// fn runs under the store's lock, so a read-modify-write through it is
	// atomic with respect to every other caller.
	Update(id int, fn func(*change.ChangeRequest) error) (*change.ChangeRequest, error)
	// Delete removes a change request.
	Delete(id int) error
	// GetMeta reads a small operational value ("" when unset).
	GetMeta(key string) string
	// SetMeta writes a small operational value.
	SetMeta(key, value string) error
}

type fileData struct {
	Seq  int                     `json:"seq"`
	CRs  []*change.ChangeRequest `json:"crs"`
	Meta map[string]string       `json:"meta,omitempty"` // small operational KV (e.g. acknowledged reconcile SHA)
}

// FileStore is a mutex-guarded JSON-file-backed change request store.
type FileStore struct {
	mu   sync.Mutex
	path string
	data fileData
}

// New loads (or initializes) the JSON-file store at path.
func New(path string) (*FileStore, error) {
	s := &FileStore{path: path}
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
func (s *FileStore) save() error {
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
func (s *FileStore) draftFor(author string) *change.ChangeRequest {
	for _, cr := range s.data.CRs {
		if cr.State == change.StateDraft && strings.EqualFold(cr.Author, author) {
			return cr
		}
	}
	return nil
}

// clone deep-copies a change request down to the slices a caller could append
// to or rewrite in place. The `any` values inside items are shared, and that is
// deliberate: they are scalars and decoded metadata that nothing mutates once
// staged, and round-tripping them through JSON to be thorough would quietly
// retype every integer the resolver read out of a YAML file.
func clone(cr *change.ChangeRequest) *change.ChangeRequest {
	if cr == nil {
		return nil
	}
	c := *cr
	c.Items = append([]change.Item(nil), cr.Items...)
	c.Comments = append([]change.Comment(nil), cr.Comments...)
	c.Approvals = append([]change.Approval(nil), cr.Approvals...)
	c.Reviewers = append([]string(nil), cr.Reviewers...)
	return &c
}

// Draft returns the author's draft CR, creating one if none exists.
func (s *FileStore) Draft(author, targetBranch string) (*change.ChangeRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cr := s.draftFor(author); cr != nil {
		return clone(cr), nil
	}
	s.data.Seq++
	cr := &change.ChangeRequest{
		ID:    s.data.Seq,
		Title: "Draft changes",
		// No Branch and no Number: both are decided at submit. A placeholder
		// branch read as a decision already taken - people expected their work
		// to land on "feature/unnamed" and were surprised when it did not.
		Author:       author,
		TargetBranch: targetBranch,
		State:        change.StateDraft,
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}
	s.data.CRs = append(s.data.CRs, cr)
	return clone(cr), s.save()
}

// CurrentDraft returns the author's draft CR or nil (no lazy creation).
func (s *FileStore) CurrentDraft(author string) *change.ChangeRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return clone(s.draftFor(author))
}

// Get returns the CR with the given id.
func (s *FileStore) Get(id int) (*change.ChangeRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, cr := range s.data.CRs {
		if cr.ID == id {
			return clone(cr), nil
		}
	}
	return nil, fmt.Errorf("change request %d not found", id)
}

// List returns all CRs, newest first.
func (s *FileStore) List() []*change.ChangeRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*change.ChangeRequest, len(s.data.CRs))
	for i, cr := range s.data.CRs {
		out[i] = clone(cr)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	return out
}

// Update applies fn to the CR with the given id and persists the result.
func (s *FileStore) Update(id int, fn func(*change.ChangeRequest) error) (*change.ChangeRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, cr := range s.data.CRs {
		if cr.ID == id {
			if err := fn(cr); err != nil {
				return nil, err
			}
			cr.UpdatedAt = time.Now().UTC()
			return clone(cr), s.save()
		}
	}
	return nil, fmt.Errorf("change request %d not found", id)
}

// GetMeta returns a small operational value ("" when unset).
func (s *FileStore) GetMeta(key string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.Meta[key]
}

// SetMeta stores a small operational value.
func (s *FileStore) SetMeta(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Meta == nil {
		s.data.Meta = map[string]string{}
	}
	s.data.Meta[key] = value
	return s.save()
}

// Delete removes the CR with the given id.
func (s *FileStore) Delete(id int) error {
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
