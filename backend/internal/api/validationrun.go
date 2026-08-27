package api

// A validation RUN is a piece of work with stages, not a request that either
// answers or does not.
//
// Holding a whole change against a model set means materializing the base
// branch, applying every draft item to it and walking each resulting file
// against several hundred modules. On a fleet-sized change that is seconds, and
// seconds behind one synchronous POST is a screen that looks frozen at exactly
// the moment somebody is committing to a production change. So the work is a
// resource: it is started, it reports which stage it is in and what it has
// found so far, and it finishes with a verdict. The client watches it happen.
//
// A run is EPHEMERAL. It lives in memory, it is rebuildable from the draft it
// describes, and a pod that restarts loses nothing a click cannot recreate -
// which is what keeps it inside the statelessness rule the rest of the server
// keeps.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/changeset"
	"github.com/abhijeet-oxide/configer/backend/internal/yangvalidate"
)

// Run states.
const (
	RunRunning = "running"
	RunPassed  = "passed"
	RunFailed  = "failed"
	// RunError means the run itself broke. It is NOT a pass: a validator that
	// could not run has found nothing and proved nothing.
	RunError = "error"
)

// Stage states.
const (
	StagePending = "pending"
	StageRunning = "running"
	StagePassed  = "passed"
	StageFailed  = "failed"
	// StageSkipped is a stage that could not run and said why - a missing
	// precondition, which is a state rather than a failure.
	StageSkipped = "skipped"
)

// Stage identifiers, ordered the way the work actually happens.
const (
	StageCollect = "collect"
	StageRules   = "rules"
	StageBuild   = "build"
	StageModel   = "model"
)

// ValidationStage is one step of a run, as the UI shows it.
type ValidationStage struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	State string `json:"state"`
	// Detail is one line saying what this stage actually did ("checked 128
	// values across 6 files"), which is the difference between a progress bar
	// and knowing something is happening.
	Detail    string `json:"detail,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
	EndedAt   string `json:"endedAt,omitempty"`
}

// ValidationRun is one validation of one change request.
type ValidationRun struct {
	ID       string `json:"id"`
	ChangeID int    `json:"changeId"`
	State    string `json:"state"`
	// Fingerprint identifies the draft this run validated. A submit only trusts
	// a run whose fingerprint still matches, so an edit made between validating
	// and submitting cannot ride in on the previous run's verdict.
	Fingerprint string            `json:"fingerprint"`
	Stages      []ValidationStage `json:"stages"`
	// Findings are the model's objections; Problems are edits that could not be
	// applied at all. Both block, and they are kept apart because they are
	// fixed in different places.
	Findings []yangvalidate.Finding  `json:"findings"`
	Problems []changeset.ItemProblem `json:"problems"`
	// Engine names what validated; Available is false when no full-document
	// validator could run, and Reason says why in words an operator can act on.
	Engine    string `json:"engine,omitempty"`
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	// Counts the UI states plainly rather than making the reader total a list.
	Errors   int `json:"errors"`
	Warnings int `json:"warnings"`
	// PreExisting counts the objections the committed files already carried.
	// They are shown and they do not block: this change did not cause them.
	PreExisting int `json:"preExisting"`
	Documents   int `json:"documents"`
	Values      int `json:"values"`
	Unmatched   int `json:"unmatched"`
	// Skipped are the checks that were passed over with an explanation - an
	// unparseable file, a condition outside what the built-in evaluator reads.
	// Silence about them would present a partial check as a complete one.
	Skipped   []string `json:"skipped,omitempty"`
	StartedAt string   `json:"startedAt"`
	EndedAt   string   `json:"endedAt,omitempty"`
}

// OK reports whether this run permits a submit.
func (r *ValidationRun) OK() bool { return r.Errors == 0 && len(r.Problems) == 0 }

// newRun lays out the stages before any work starts, so the UI can draw the
// whole road on the first frame rather than growing a list under the reader.
func newRun(changeID int, fingerprint string) *ValidationRun {
	return &ValidationRun{
		ID:          runID(),
		ChangeID:    changeID,
		State:       RunRunning,
		Fingerprint: fingerprint,
		Findings:    []yangvalidate.Finding{},
		Problems:    []changeset.ItemProblem{},
		StartedAt:   time.Now().UTC().Format(time.RFC3339Nano),
		Stages: []ValidationStage{
			{ID: StageCollect, Label: "Reading your changes", State: StagePending},
			{ID: StageRules, Label: "Checking each value against its rules", State: StagePending},
			{ID: StageBuild, Label: "Building the files this change would commit", State: StagePending},
			{ID: StageModel, Label: "Validating against the data model", State: StagePending},
		},
	}
}

func (r *ValidationRun) stage(id string) *ValidationStage {
	for i := range r.Stages {
		if r.Stages[i].ID == id {
			return &r.Stages[i]
		}
	}
	return nil
}

// runs holds the validation runs in flight and the last one per change.
//
// Bounded on purpose: a run is a few kilobytes and a busy workspace would
// otherwise accumulate one per click for the life of the process.
type runs struct {
	mu      sync.Mutex
	byID    map[string]*ValidationRun
	latest  map[int]string
	order   []string
	maxRuns int
}

func newRuns() *runs {
	return &runs{byID: map[string]*ValidationRun{}, latest: map[int]string{}, maxRuns: 64}
}

func (rs *runs) put(r *ValidationRun) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	rs.byID[r.ID] = r
	rs.latest[r.ChangeID] = r.ID
	rs.order = append(rs.order, r.ID)
	for len(rs.order) > rs.maxRuns {
		oldest := rs.order[0]
		rs.order = rs.order[1:]
		if old := rs.byID[oldest]; old != nil && rs.latest[old.ChangeID] == oldest {
			delete(rs.latest, old.ChangeID)
		}
		delete(rs.byID, oldest)
	}
}

// get returns a COPY. A run is mutated by the goroutine doing the work, and
// handing the live struct to a handler that is about to marshal it is how a
// poll reads a half-written stage.
func (rs *runs) get(id string) (*ValidationRun, bool) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	r, found := rs.byID[id]
	if !found {
		return nil, false
	}
	return r.clone(), true
}

func (rs *runs) latestFor(changeID int) (*ValidationRun, bool) {
	rs.mu.Lock()
	id, found := rs.latest[changeID]
	rs.mu.Unlock()
	if !found {
		return nil, false
	}
	return rs.get(id)
}

// update applies a mutation under the registry's own lock, which is what makes
// a poll and the worker safe to run at once.
func (rs *runs) update(id string, fn func(*ValidationRun)) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if r, found := rs.byID[id]; found {
		fn(r)
	}
}

func (r *ValidationRun) clone() *ValidationRun {
	out := *r
	out.Stages = append([]ValidationStage{}, r.Stages...)
	out.Findings = append([]yangvalidate.Finding{}, r.Findings...)
	out.Problems = append([]changeset.ItemProblem{}, r.Problems...)
	out.Skipped = append([]string{}, r.Skipped...)
	return &out
}

// fingerprintOf identifies a draft by what it would WRITE, so an edit that
// changes nothing (staged and undone, restaged the same) reuses a verdict and
// an edit that changes something cannot.
func fingerprintOf(cr *change.ChangeRequest) string {
	if cr == nil {
		return ""
	}
	parts := make([]string, 0, len(cr.Items))
	for _, it := range cr.Items {
		parts = append(parts, fmt.Sprintf("%s|%s|%s|%s|%v",
			it.Action, it.ParamID, it.Instance, it.File, it.New))
	}
	// Order must not matter: two drafts holding the same edits are the same
	// change whatever sequence they were staged in.
	sort.Strings(parts)
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

var runSeq struct {
	mu sync.Mutex
	n  int64
}

// runID is a short, sortable identifier. It needs to be unique within one
// process and readable in a log; it is never persisted and never addresses
// anything a user typed.
func runID() string {
	runSeq.mu.Lock()
	runSeq.n++
	n := runSeq.n
	runSeq.mu.Unlock()
	return "vr-" + strconv.FormatInt(time.Now().UnixMilli(), 36) + "-" + strconv.FormatInt(n, 36)
}

func nowStamp() string { return time.Now().UTC().Format(time.RFC3339Nano) }
