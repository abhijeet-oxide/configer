package api

// The configuration timeline: how this application's configuration EVOLVED,
// as a series of snapshots a user can inspect and roll back to.
//
// Two endpoints, one model:
//   - /api/timeline           the scoped list of snapshots, each classified
//                             (version upgrade / configuration change /
//                             instance added or retired) with change counts;
//   - /api/timeline/snapshot  one snapshot opened up: every parameter that
//                             changed, with its before and after value.
//
// A snapshot is compared against the PREVIOUS SNAPSHOT IN THE SAME SCOPE, not
// against its raw git parent. For an instance timeline that answers the
// question users actually ask - "what changed about this instance since the
// last time it changed?" - and it keeps an instance's story readable even when
// unrelated commits land in between.
//
// Restoring is not done here: every dot links to POST /api/restore, so going
// back is an ordinary reviewable draft edit, never a history rewrite.

import (
	"net/http"
	"sort"
	"strconv"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/repobackend"
	"github.com/abhijeet-oxide/configer/backend/internal/resolver"
)

// Snapshot kinds, in the order a mixed snapshot is labelled by.
const (
	kindVersion    = "version"    // an instance's software version moved
	kindStructural = "structural" // an instance was added or retired
	kindConfig     = "config"     // parameter values changed
	kindNone       = "none"       // nothing this scope cares about
)

// cellKey identifies one resolved cell across snapshots. The instance is empty
// for a shared/global value.
func cellKey(paramID, instance string) string { return paramID + "\x00" + instance }

// snapshotState is one commit's configuration reduced to what the timeline
// compares: every resolved cell value, plus instance identity and versions.
type snapshotState struct {
	values   map[string]string // cellKey -> rendered value
	names    map[string]string // paramID -> display name
	versions map[string]string // instance -> software version
	insts    map[string]bool   // instance names present at this commit
}

// readSnapshot resolves a materialized project into a comparable state. When
// instanceFilter is set only that instance's cells are read, which keeps an
// instance timeline cheap on a large fleet.
func readSnapshot(p *project.Project, instanceFilter string) snapshotState {
	st := snapshotState{
		values:   map[string]string{},
		names:    map[string]string{},
		versions: map[string]string{},
		insts:    map[string]bool{},
	}
	rv := resolver.NewWithCatalog(p.Root, p.Catalog.Parameters)
	for _, inst := range p.Registry.Instances {
		if instanceFilter != "" && inst.Name != instanceFilter {
			continue
		}
		st.insts[inst.Name] = true
		st.versions[inst.Name] = inst.SoftwareVersion
	}
	for _, param := range p.Catalog.Parameters {
		st.names[param.ID] = param.Name
		if param.Scope == model.ScopeGlobal {
			// A shared value belongs to the whole application; it is part of an
			// instance's story too, since it feeds every instance.
			res := rv.Resolve(param, model.Instance{})
			if res.Set {
				st.values[cellKey(param.ID, "")] = valueString(res.Value)
			}
			continue
		}
		for _, inst := range p.Registry.Instances {
			if instanceFilter != "" && inst.Name != instanceFilter {
				continue
			}
			if len(param.BindingsOn(model.LayerInstance, inst)) == 0 {
				continue
			}
			res := rv.Resolve(param, inst)
			if res.Set {
				st.values[cellKey(param.ID, inst.Name)] = valueString(res.Value)
			}
		}
	}
	return st
}

// VersionMove records an instance's software version changing at a snapshot.
type VersionMove struct {
	Instance string `json:"instance"`
	From     string `json:"from"`
	To       string `json:"to"`
}

// InstanceMove records an instance appearing or being retired at a snapshot.
type InstanceMove struct {
	Instance string `json:"instance"`
	Action   string `json:"action"` // added | removed
}

// CellChange is one parameter cell's before/after across a snapshot boundary.
type CellChange struct {
	ParamID  string `json:"paramId"`
	Name     string `json:"name"`
	Instance string `json:"instance,omitempty"` // empty = shared/global value
	Before   string `json:"before"`
	After    string `json:"after"`
	Status   string `json:"status"` // added | removed | modified
}

// ChangeSummary counts what a snapshot did.
type ChangeSummary struct {
	Added    int `json:"added"`
	Removed  int `json:"removed"`
	Modified int `json:"modified"`
	Total    int `json:"total"`
}

// TimelineEntry is one dot on the timeline.
type TimelineEntry struct {
	repobackend.Commit
	// Previous is the snapshot this one is compared against ("" for the oldest
	// entry, which has no predecessor in view).
	Previous string `json:"previous,omitempty"`
	// Kind classifies the dot so the timeline can be read at a glance.
	Kind      string         `json:"kind"`
	Summary   ChangeSummary  `json:"summary"`
	Instances []string       `json:"instances,omitempty"` // instances whose values moved
	Versions  []VersionMove  `json:"versions,omitempty"`
	Structure []InstanceMove `json:"structure,omitempty"`
}

// diffStates compares two snapshot states and returns the per-cell changes.
func diffStates(prev, cur snapshotState) []CellChange {
	seen := map[string]bool{}
	keys := make([]string, 0, len(cur.values)+len(prev.values))
	for k := range cur.values {
		keys = append(keys, k)
		seen[k] = true
	}
	for k := range prev.values {
		if !seen[k] {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)

	out := make([]CellChange, 0, 8)
	for _, k := range keys {
		before, hadBefore := prev.values[k]
		after, hadAfter := cur.values[k]
		if before == after && hadBefore == hadAfter {
			continue
		}
		paramID, instance := splitCellKey(k)
		name := cur.names[paramID]
		if name == "" {
			name = prev.names[paramID]
		}
		ch := CellChange{ParamID: paramID, Name: name, Instance: instance, Before: before, After: after}
		switch {
		case !hadBefore && hadAfter:
			ch.Status = "added"
		case hadBefore && !hadAfter:
			ch.Status = "removed"
		default:
			ch.Status = "modified"
		}
		out = append(out, ch)
	}
	return out
}

// splitCellKey reverses cellKey.
func splitCellKey(k string) (paramID, instance string) {
	for i := 0; i < len(k); i++ {
		if k[i] == 0 {
			return k[:i], k[i+1:]
		}
	}
	return k, ""
}

// classify turns a set of cell changes plus identity moves into a snapshot's
// headline kind and summary. A snapshot that moved a version is labelled a
// version upgrade even when values moved with it, because that is the change a
// user recognizes; the value detail is still there when the dot is opened.
func classify(changes []CellChange, versions []VersionMove, structure []InstanceMove) (string, ChangeSummary, []string) {
	var sum ChangeSummary
	instSeen := map[string]bool{}
	var instances []string
	for _, c := range changes {
		switch c.Status {
		case "added":
			sum.Added++
		case "removed":
			sum.Removed++
		default:
			sum.Modified++
		}
		sum.Total++
		if c.Instance != "" && !instSeen[c.Instance] {
			instSeen[c.Instance] = true
			instances = append(instances, c.Instance)
		}
	}
	sort.Strings(instances)

	kind := kindNone
	switch {
	case len(versions) > 0:
		kind = kindVersion
	case len(structure) > 0:
		kind = kindStructural
	case sum.Total > 0:
		kind = kindConfig
	}
	return kind, sum, instances
}

// identityMoves compares instance registries between two snapshots.
func identityMoves(prev, cur snapshotState) ([]VersionMove, []InstanceMove) {
	var versions []VersionMove
	var structure []InstanceMove

	names := make([]string, 0, len(cur.insts)+len(prev.insts))
	for n := range cur.insts {
		names = append(names, n)
	}
	for n := range prev.insts {
		if !cur.insts[n] {
			names = append(names, n)
		}
	}
	sort.Strings(names)

	for _, n := range names {
		inPrev, inCur := prev.insts[n], cur.insts[n]
		switch {
		case !inPrev && inCur:
			structure = append(structure, InstanceMove{Instance: n, Action: "added"})
		case inPrev && !inCur:
			structure = append(structure, InstanceMove{Instance: n, Action: "removed"})
		default:
			if prev.versions[n] != cur.versions[n] {
				versions = append(versions, VersionMove{Instance: n, From: prev.versions[n], To: cur.versions[n]})
			}
		}
	}
	return versions, structure
}

// timelineLogPaths scopes the commit log to what the requested view cares
// about: one instance's own folder plus the shared model, or the whole
// repository when no instance is named.
func timelineLogPaths(p *project.Project, instance string) []string {
	if instance == "" {
		return []string{""} // whole repository
	}
	var paths []string
	if p != nil {
		for _, inst := range p.Registry.Instances {
			if inst.Name == instance {
				if f := inst.FolderOrDefault(); f != "" {
					paths = append(paths, f)
				}
				break
			}
		}
	}
	paths = append(paths, ".configer")
	return paths
}

// timeline returns the scoped list of configuration snapshots.
//
// @Summary     Configuration timeline
// @Description The application's configuration history as a list of snapshots, newest first. Each entry is classified (`version` upgrade, `structural` instance add/retire, `config` value change) and carries change counts, the instances it touched and any version moves. `?instance=` narrows the timeline to one instance's own story. Each snapshot is compared against the previous snapshot IN THE SAME SCOPE. `supported` is false on backends that cannot serve a log.
// @Tags        Grid & parameters
// @Produce     json
// @Param       instance query string false "Narrow the timeline to one instance"
// @Param       limit    query int    false "Max snapshots (1-40, default 15)"
// @Success     200 {object} map[string]interface{}
// @Failure     500 {object} APIError
// @Router      /api/timeline [get]
func (s *Server) timeline(w http.ResponseWriter, r *http.Request) {
	instance := r.URL.Query().Get("instance")
	limit := 15
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n <= 40 {
		limit = n
	}
	head, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	// One extra commit so the oldest visible dot still has a predecessor to be
	// compared against.
	commits, err := s.logUnion(timelineLogPaths(head, instance), limit+1)
	if err != nil {
		writeErr(w, err)
		return
	}

	// Resolve every commit in the window. Memoized by (commit, scope) and
	// computed in parallel for the ones not already known, so a revisit costs
	// only the commits made since - see snapshotcache.go.
	shas := make([]string, 0, len(commits))
	for _, c := range commits {
		shas = append(shas, c.SHA)
	}
	states := s.snapshotsAt(shas, instance)

	entries := make([]TimelineEntry, 0, len(commits))
	for i, c := range commits {
		cur, ok := states[c.SHA]
		if !ok {
			continue
		}
		e := TimelineEntry{Commit: c, Kind: kindNone}
		// The next-older commit in this scope is the comparison baseline.
		for j := i + 1; j < len(commits); j++ {
			prev, prevOK := states[commits[j].SHA]
			if !prevOK {
				continue
			}
			e.Previous = commits[j].SHA
			versions, structure := identityMoves(prev, cur)
			changes := diffStates(prev, cur)
			e.Versions, e.Structure = versions, structure
			e.Kind, e.Summary, e.Instances = classify(changes, versions, structure)
			break
		}
		entries = append(entries, e)
	}
	if len(entries) > limit {
		entries = entries[:limit]
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"scope":     scopeLabel(instance),
		"instance":  instance,
		"snapshots": entries,
		"supported": s.Backend.Kind() == "local",
	})
}

func scopeLabel(instance string) string {
	if instance == "" {
		return "all"
	}
	return "instance"
}

// timelineSnapshot opens one dot: every parameter that changed at it.
//
// @Summary     Open one timeline snapshot
// @Description Every parameter that changed at one snapshot, with its before and after value, plus any version or instance-identity moves. The comparison baseline is the previous snapshot in the same scope, so `?instance=` must match the timeline the snapshot was read from. Feed `sha` to POST /api/restore to bring any scope back to this point.
// @Tags        Grid & parameters
// @Produce     json
// @Param       sha      query string true  "Snapshot commit sha"
// @Param       instance query string false "Scope the comparison to one instance"
// @Param       limit    query int    false "How far back to look for the baseline (1-40, default 15)"
// @Success     200 {object} map[string]interface{}
// @Failure     400 {object} APIError "sha is required"
// @Failure     404 {object} APIError "Unknown snapshot"
// @Router      /api/timeline/snapshot [get]
func (s *Server) timelineSnapshot(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	sha := q.Get("sha")
	if sha == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "a snapshot is required")
		return
	}
	instance := q.Get("instance")
	limit := 15
	if n, err := strconv.Atoi(q.Get("limit")); err == nil && n > 0 && n <= 40 {
		limit = n
	}

	head, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	commits, err := s.logUnion(timelineLogPaths(head, instance), limit+1)
	if err != nil {
		writeErr(w, err)
		return
	}
	// Find the requested snapshot and the previous one in the same scope.
	idx := -1
	for i, c := range commits {
		if c.SHA == sha || c.Short == sha {
			idx = i
			break
		}
	}
	if idx < 0 {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "that snapshot is not in this timeline")
		return
	}

	// Both states almost always come straight from the cache the list request
	// filled, so opening a dot no longer walks the history a second time.
	cur, ok := s.snapshotAt(commits[idx].SHA, instance)
	if !ok {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "cannot read that snapshot")
		return
	}

	var prev snapshotState
	prevSHA := ""
	if idx+1 < len(commits) {
		if st, pok := s.snapshotAt(commits[idx+1].SHA, instance); pok {
			prev = st
			prevSHA = commits[idx+1].SHA
		}
	}
	if prev.values == nil {
		// No predecessor in view: everything present is the starting point, so
		// there is nothing to show as changed.
		prev = snapshotState{values: map[string]string{}, names: map[string]string{},
			versions: map[string]string{}, insts: map[string]bool{}}
	}

	versions, structure := identityMoves(prev, cur)
	changes := diffStates(prev, cur)
	kind, summary, instances := classify(changes, versions, structure)

	writeJSON(w, http.StatusOK, map[string]any{
		"commit":    commits[idx],
		"previous":  prevSHA,
		"kind":      kind,
		"summary":   summary,
		"instances": instances,
		"versions":  versions,
		"structure": structure,
		"changes":   changes,
		"instance":  instance,
		"supported": s.Backend.Kind() == "local",
	})
}
