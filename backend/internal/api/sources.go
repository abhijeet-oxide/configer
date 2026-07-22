package api

// External parameter sources: the HTTP surface for defining sources, browsing
// and viewing their contents, mapping a parameter to a source key, and turning
// upstream values into reviewable "incoming changes" the reviewer accepts into
// the normal draft. Fetched values are cached in the CR store so the grid is
// never blocked on a network call; secrets are masked and written back as a
// reference, never as plaintext.

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/resolver"
	"github.com/abhijeet-oxide/configer/backend/internal/validate"
	"github.com/abhijeet-oxide/configer/backend/internal/writer"
)

// snapshotKey is the CR-store Meta key holding one source's last fetched
// key/value set (JSON). Keeping it out of Git (the store lives beside the repo)
// is deliberate: fetched values are cache, never configuration.
func snapshotKey(sourceID string) string { return "sourceSnapshot:" + sourceID }

// sourcePlugins lists the registered source providers (with their config
// fields) so the UI can render the "Add source" catalog and dynamic form.
//
// @Summary     List source plugins
// @Description The registered external-source provider manifests (git, vault, ...) with the config fields each needs.
// @Tags        Sources
// @Produce     json
// @Success     200 {array} object
// @Router      /api/source-plugins [get]
func (s *Server) sourcePlugins(w http.ResponseWriter, _ *http.Request) {
	type dto struct {
		plugin.Manifest
		Fields []plugin.SourceField `json:"fields"`
	}
	var out []dto
	for _, p := range s.Registry.Sources() {
		out = append(out, dto{Manifest: p.Manifest(), Fields: p.Fields()})
	}
	writeJSON(w, http.StatusOK, out)
}

// sourceDTO is a configured source plus display/derived fields.
type sourceDTO struct {
	model.Source
	PluginName   string `json:"pluginName,omitempty"`
	MappedParams int    `json:"mappedParams"`
}

// listSources returns the configured external sources.
//
// @Summary     List configured sources
// @Description Every external source defined for this application, with how many parameters are mapped to each.
// @Tags        Sources
// @Produce     json
// @Success     200 {array} object
// @Router      /api/sources [get]
func (s *Server) listSources(w http.ResponseWriter, _ *http.Request) {
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	mapped := map[string]int{}
	for _, param := range p.Catalog.Parameters {
		if param.Source != nil {
			mapped[param.Source.SourceID]++
		}
	}
	out := make([]sourceDTO, 0, len(p.Sources.Sources))
	for _, src := range p.Sources.Sources {
		d := sourceDTO{Source: src, MappedParams: mapped[src.ID]}
		if prov, perr := s.Registry.SourceByKind(src.Kind); perr == nil {
			d.PluginName = prov.Manifest().Name
		}
		out = append(out, d)
	}
	writeJSON(w, http.StatusOK, out)
}

// addSource defines a new external source.
//
// @Summary     Add a source
// @Description Define an external source (its kind must match a registered plugin). Non-secret connection details only; credentials are resolved server-side.
// @Tags        Sources
// @Accept      json
// @Produce     json
// @Param       body body object true "{name, kind, secret?, config}"
// @Success     201 {object} object
// @Failure     400 {object} APIError
// @Failure     409 {object} APIError
// @Security    CookieSession
// @Router      /api/sources [post]
func (s *Server) addSource(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID     string            `json:"id"`
		Name   string            `json:"name"`
		Kind   string            `json:"kind"`
		Secret bool              `json:"secret"`
		Config map[string]string `json:"config"`
		Author string            `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "a source name is required")
		return
	}
	if _, err := s.Registry.SourceByKind(req.Kind); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "unknown source kind: "+req.Kind)
		return
	}
	id := strings.TrimSpace(req.ID)
	if id == "" {
		id = slugify(req.Name)
	}
	src := model.Source{ID: id, Name: req.Name, Kind: req.Kind, Secret: req.Secret, Config: req.Config}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := writer.AddSource(s.RepoPath, src); err != nil {
		writeError(w, r, http.StatusConflict, CodeConflict, err.Error())
		return
	}
	s.commitCatalogCreate(w, r, "Add source "+req.Name, req.Author, "/api/sources/"+id, src)
}

// updateSource patches a source's metadata.
//
// @Summary     Update a source
// @Description Patch a source's name, secret flag or connection config.
// @Tags        Sources
// @Accept      json
// @Produce     json
// @Param       id   path string true "Source id"
// @Param       body body object true "{name?, secret?, config?}"
// @Success     200 {object} object
// @Failure     404 {object} APIError
// @Security    CookieSession
// @Router      /api/sources/{id} [put]
func (s *Server) updateSource(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct {
		Name   *string            `json:"name"`
		Secret *bool              `json:"secret"`
		Config *map[string]string `json:"config"`
		Author string             `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	updated, err := writer.UpdateSource(s.RepoPath, id, writer.SourcePatch{Name: req.Name, Secret: req.Secret, Config: req.Config})
	if err != nil {
		writeError(w, r, http.StatusNotFound, CodeNotFound, err.Error())
		return
	}
	// A changed config invalidates the cached snapshot.
	_ = s.Store.SetMeta(snapshotKey(id), "")
	s.commitCatalogChange(w, r, "Update source "+updated.Name, req.Author, updated)
}

// deleteSource removes a source definition.
//
// @Summary     Delete a source
// @Description Remove an external source. Parameters mapped to it keep their reference until re-mapped or cleared.
// @Tags        Sources
// @Produce     json
// @Param       id path string true "Source id"
// @Success     200 {object} map[string]interface{}
// @Failure     404 {object} APIError
// @Security    CookieSession
// @Router      /api/sources/{id} [delete]
func (s *Server) deleteSource(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct {
		Author string `json:"author"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := writer.DeleteSource(s.RepoPath, id); err != nil {
		writeError(w, r, http.StatusNotFound, CodeNotFound, err.Error())
		return
	}
	_ = s.Store.SetMeta(snapshotKey(id), "")
	s.commitCatalogChange(w, r, "Remove source "+id, req.Author, map[string]any{"ok": true, "removed": id})
}

// browseSource lists selectable entries under a path inside a source, for the
// folder/file/key picker.
//
// @Summary     Browse a source
// @Description List the immediate children (folders, config files, secret keys) under a path within a source.
// @Tags        Sources
// @Produce     json
// @Param       id   path  string true  "Source id"
// @Param       path query string false "Path within the source (blank for the root)"
// @Success     200 {object} map[string]interface{}
// @Failure     404 {object} APIError
// @Failure     502 {object} APIError
// @Router      /api/sources/{id}/browse [get]
func (s *Server) browseSource(w http.ResponseWriter, r *http.Request) {
	src, prov, ok := s.sourceAndProvider(w, r)
	if !ok {
		return
	}
	entries, err := prov.Browse(r.Context(), s.sourceConfig(src), r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, r, http.StatusBadGateway, CodeUpstreamError, "could not read the source: "+err.Error())
		return
	}
	if entries == nil {
		entries = []plugin.BrowseEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

// sourceContents returns the key/value pairs a source exposes (secrets masked),
// the "view inside a source" page. It refreshes and caches the snapshot.
//
// @Summary     View source contents
// @Description Fetch the key/value pairs a source exposes right now (secret values masked). Refreshes the cached snapshot.
// @Tags        Sources
// @Produce     json
// @Param       id path string true "Source id"
// @Success     200 {object} map[string]interface{}
// @Failure     404 {object} APIError
// @Failure     502 {object} APIError
// @Router      /api/sources/{id}/contents [get]
func (s *Server) sourceContents(w http.ResponseWriter, r *http.Request) {
	src, prov, ok := s.sourceAndProvider(w, r)
	if !ok {
		return
	}
	kvs, err := prov.Fetch(r.Context(), s.sourceConfig(src))
	if err != nil {
		writeError(w, r, http.StatusBadGateway, CodeUpstreamError, "could not read the source: "+err.Error())
		return
	}
	s.cacheSnapshot(src.ID, kvs)
	writeJSON(w, http.StatusOK, map[string]any{"source": src, "count": len(kvs), "values": kvs})
}

// mapParameterSource sets or clears a parameter's mapping to a source key.
//
// @Summary     Map a parameter to a source
// @Description Point a managed parameter at a key in an external source, or clear the mapping (send null / {"clear":true}).
// @Tags        Sources
// @Accept      json
// @Produce     json
// @Param       id   path string true "Parameter id"
// @Param       body body object true "{sourceId, key, instance?} or {clear:true}"
// @Success     200 {object} object
// @Failure     400 {object} APIError
// @Failure     404 {object} APIError
// @Security    CookieSession
// @Router      /api/parameters/{id}/source [post]
func (s *Server) mapParameterSource(w http.ResponseWriter, r *http.Request) {
	paramID := r.PathValue("id")
	var req struct {
		Clear    bool   `json:"clear"`
		SourceID string `json:"sourceId"`
		Key      string `json:"key"`
		Instance string `json:"instance"`
		Author   string `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
		return
	}
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, found := p.ParamByID(paramID); !found {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "parameter not found")
		return
	}
	var ref *model.SourceRef
	if !req.Clear && req.SourceID != "" {
		if _, ok := p.SourceByID(req.SourceID); !ok {
			writeError(w, r, http.StatusNotFound, CodeNotFound, "source not found")
			return
		}
		ref = &model.SourceRef{SourceID: req.SourceID, Key: req.Key, Instance: req.Instance}
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := writer.MapParameterSource(s.RepoPath, paramID, ref); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, err.Error())
		return
	}
	title := "Map " + paramID + " to source"
	if ref == nil {
		title = "Unmap " + paramID + " from source"
	}
	s.commitCatalogChange(w, r, title, req.Author, map[string]any{"ok": true, "source": ref})
}

// IncomingChange is one upstream value that differs from the repository's
// current value: the reviewer's unit of decision.
type IncomingChange struct {
	ParamID   string `json:"paramId"`
	ParamName string `json:"paramName"`
	Instance  string `json:"instance,omitempty"` // "" = global / parameter scope
	SourceID  string `json:"sourceId"`
	SourceName string `json:"sourceName"`
	Key       string `json:"key"`
	Current   any    `json:"current"`
	Incoming  any    `json:"incoming"`
	Secret    bool   `json:"secret,omitempty"`
}

// incomingChanges compares every mapped parameter's upstream value against the
// repository's current value and returns the differences.
//
// @Summary     Incoming source changes
// @Description For every parameter mapped to a source, the upstream value that differs from the repository's current value. Reads the cached snapshot (fetching lazily when empty).
// @Tags        Sources
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Failure     500 {object} APIError
// @Router      /api/sources/incoming [get]
func (s *Server) incomingChanges(w http.ResponseWriter, r *http.Request) {
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	out := s.computeIncoming(r.Context(), p)
	writeJSON(w, http.StatusOK, map[string]any{"changes": out})
}

// computeIncoming builds the incoming-change list. Per-source snapshots are
// fetched lazily (and cached) when absent, so opening the view pulls sources.
func (s *Server) computeIncoming(ctx context.Context, p *project.Project) []IncomingChange {
	rv := resolver.NewWithCatalog(p.Root, p.Catalog.Parameters)
	snaps := map[string]map[string]plugin.SourceKV{}
	out := []IncomingChange{}
	for _, param := range p.Catalog.Parameters {
		if param.Source == nil {
			continue
		}
		src, ok := p.SourceByID(param.Source.SourceID)
		if !ok {
			continue
		}
		kv, ok := s.snapshotValue(ctx, snaps, src, param.Source.Key)
		if !ok {
			continue
		}
		incoming := kv.Value
		if kv.Secret {
			incoming = kv.Ref // never the plaintext; the reference is what gets written
		}
		for _, inst := range targetInstances(p, param) {
			current := rv.Resolve(param, inst).Value
			if stringify(current) == stringify(incoming) {
				continue
			}
			out = append(out, IncomingChange{
				ParamID: param.ID, ParamName: param.Name, Instance: inst.Name,
				SourceID: src.ID, SourceName: src.Name, Key: param.Source.Key,
				Current: current, Incoming: incoming, Secret: kv.Secret,
			})
		}
	}
	return out
}

// targetInstances returns the instances a mapping applies to: the named
// instance, or the empty instance for a global parameter, or every active
// instance for an unqualified instance-scoped parameter.
func targetInstances(p *project.Project, param model.Parameter) []model.Instance {
	if param.Source != nil && param.Source.Instance != "" {
		if inst, ok := p.InstanceByName(param.Source.Instance); ok {
			return []model.Instance{inst}
		}
		return nil
	}
	if param.Scope == model.ScopeGlobal {
		return []model.Instance{{}}
	}
	var out []model.Instance
	for _, inst := range p.Registry.Instances {
		if inst.Status == "archived" {
			continue
		}
		out = append(out, inst)
	}
	return out
}

// acceptIncoming stages selected incoming changes into the draft as ordinary
// value edits; the reviewer then submits the draft as any other change.
//
// @Summary     Accept incoming changes
// @Description Stage selected incoming source values into the draft change request (as normal cell edits). Secret values stage as their reference. Submit the draft to publish.
// @Tags        Sources
// @Accept      json
// @Produce     json
// @Param       body body object true "{changes:[{paramId,instance}], author?}"
// @Success     200 {object} object
// @Failure     400 {object} APIError
// @Security    CookieSession
// @Router      /api/sources/incoming/accept [post]
func (s *Server) acceptIncoming(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Changes []struct {
			ParamID  string `json:"paramId"`
			Instance string `json:"instance"`
		} `json:"changes"`
		Author string `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "invalid request body")
		return
	}
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	// Index the current incoming set so accept works off the same values the
	// reviewer saw (and validates membership: only real differences stage).
	wanted := map[string]bool{}
	for _, c := range req.Changes {
		wanted[c.ParamID+"\x00"+c.Instance] = true
	}
	all := s.computeIncoming(r.Context(), p)

	type result struct {
		ParamID  string `json:"paramId"`
		Instance string `json:"instance"`
		OK       bool   `json:"ok"`
		Error    string `json:"error,omitempty"`
	}
	results := []result{}
	staged := 0

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	draft, err := s.Store.Draft(author(r, req.Author), s.branch())
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, err = s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
		for _, ic := range all {
			if len(wanted) > 0 && !wanted[ic.ParamID+"\x00"+ic.Instance] {
				continue
			}
			param, ok := p.ParamByID(ic.ParamID)
			if !ok {
				continue
			}
			newVal, errMsg := valueForAccept(param, ic)
			if errMsg != "" {
				results = append(results, result{ParamID: ic.ParamID, Instance: ic.Instance, Error: errMsg})
				continue
			}
			it := change.Item{ParamID: ic.ParamID, Instance: ic.Instance, Action: change.ActionSet,
				Old: ic.Current, New: newVal, UpdatedAt: time.Now().UTC()}
			if ic.Instance == "" {
				it.Scope = "global"
			}
			cr.UpsertItem(it)
			staged++
			results = append(results, result{ParamID: ic.ParamID, Instance: ic.Instance, OK: true})
		}
		return nil
	}); err != nil {
		writeErr(w, err)
		return
	}

	d := s.Store.CurrentDraft()
	pending, changeID := 0, draft.ID
	if d != nil {
		pending, changeID = len(d.Items), d.ID
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "staged": staged, "results": results, "pending": pending, "changeId": changeID})
}

// valueForAccept produces the value staged for an incoming change. A secret
// change stages its reference string verbatim (no type coercion); a normal
// value is coerced and validated against the parameter like any cell edit.
func valueForAccept(param model.Parameter, ic IncomingChange) (any, string) {
	if ic.Secret {
		return ic.Incoming, ""
	}
	coerced, err := validate.CoerceValue(param, ic.Incoming)
	if err != nil {
		return nil, err.Error()
	}
	if vr := validate.Value(param, coerced); !vr.Valid {
		return nil, vr.Message
	}
	return coerced, ""
}

// refreshSources re-fetches every source into the cache.
//
// @Summary     Refresh sources
// @Description Re-fetch every configured source and update the cached snapshots the incoming-changes view reads.
// @Tags        Sources
// @Produce     json
// @Success     200 {object} map[string]interface{}
// @Failure     500 {object} APIError
// @Security    CookieSession
// @Router      /api/sources/refresh [post]
func (s *Server) refreshSources(w http.ResponseWriter, r *http.Request) {
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return
	}
	type srcResult struct {
		ID    string `json:"id"`
		OK    bool   `json:"ok"`
		Count int    `json:"count,omitempty"`
		Error string `json:"error,omitempty"`
	}
	results := make([]srcResult, 0, len(p.Sources.Sources))
	for _, src := range p.Sources.Sources {
		prov, perr := s.Registry.SourceByKind(src.Kind)
		if perr != nil {
			results = append(results, srcResult{ID: src.ID, Error: "unknown source kind"})
			continue
		}
		kvs, ferr := prov.Fetch(r.Context(), s.sourceConfig(src))
		if ferr != nil {
			results = append(results, srcResult{ID: src.ID, Error: ferr.Error()})
			continue
		}
		s.cacheSnapshot(src.ID, kvs)
		results = append(results, srcResult{ID: src.ID, OK: true, Count: len(kvs)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sources": results, "refreshedAt": time.Now().UTC()})
}

// --- shared helpers ----------------------------------------------------------

// sourceAndProvider resolves the {id} path value to a configured source and its
// provider, writing the appropriate error and returning ok=false on failure.
func (s *Server) sourceAndProvider(w http.ResponseWriter, r *http.Request) (model.Source, plugin.SourceProvider, bool) {
	id := r.PathValue("id")
	p, err := s.load()
	if err != nil {
		writeErr(w, err)
		return model.Source{}, nil, false
	}
	src, ok := p.SourceByID(id)
	if !ok {
		writeError(w, r, http.StatusNotFound, CodeNotFound, "source not found")
		return model.Source{}, nil, false
	}
	prov, perr := s.Registry.SourceByKind(src.Kind)
	if perr != nil {
		writeError(w, r, http.StatusBadRequest, CodeBadRequest, "unknown source kind: "+src.Kind)
		return model.Source{}, nil, false
	}
	return src, prov, true
}

// sourceConfig builds the provider config for a source, resolving its
// credential from the environment (never from committed metadata).
func (s *Server) sourceConfig(src model.Source) plugin.SourceConfig {
	return plugin.SourceConfig{Values: src.Config, Secret: sourceCredential(src.Kind)}
}

// sourceCredential resolves a source kind's credential from the environment.
// Known kinds map to their conventional variable; any kind also honors a
// CONFIGER_SOURCE_<KIND>_TOKEN override, so a new provider needs no code here.
func sourceCredential(kind string) string {
	switch kind {
	case "git":
		if t := os.Getenv("GITHUB_TOKEN"); t != "" {
			return t
		}
	case "vault":
		if t := os.Getenv("VAULT_TOKEN"); t != "" {
			return t
		}
	}
	return os.Getenv("CONFIGER_SOURCE_" + strings.ToUpper(kind) + "_TOKEN")
}

// cacheSnapshot stores a source's fetched key/value set in the CR store (best
// effort; the cache is always reconstructible by re-fetching).
func (s *Server) cacheSnapshot(sourceID string, kvs []plugin.SourceKV) {
	b, err := json.Marshal(kvs)
	if err != nil {
		return
	}
	_ = s.Store.SetMeta(snapshotKey(sourceID), string(b))
}

// snapshotValue returns the SourceKV for key in src, fetching and caching the
// source's snapshot on first use within a request (snaps memoizes per source).
func (s *Server) snapshotValue(ctx context.Context, snaps map[string]map[string]plugin.SourceKV, src model.Source, key string) (plugin.SourceKV, bool) {
	byKey, ok := snaps[src.ID]
	if !ok {
		byKey = s.loadSnapshot(ctx, src)
		snaps[src.ID] = byKey
	}
	kv, ok := byKey[key]
	return kv, ok
}

// loadSnapshot reads a source's cached snapshot, fetching (and caching) it when
// the cache is empty so the incoming view pulls sources on demand.
func (s *Server) loadSnapshot(ctx context.Context, src model.Source) map[string]plugin.SourceKV {
	byKey := map[string]plugin.SourceKV{}
	raw := s.Store.GetMeta(snapshotKey(src.ID))
	if raw == "" {
		prov, perr := s.Registry.SourceByKind(src.Kind)
		if perr != nil {
			return byKey
		}
		kvs, ferr := prov.Fetch(ctx, s.sourceConfig(src))
		if ferr != nil {
			return byKey
		}
		s.cacheSnapshot(src.ID, kvs)
		for _, kv := range kvs {
			byKey[kv.Key] = kv
		}
		return byKey
	}
	var kvs []plugin.SourceKV
	if err := json.Unmarshal([]byte(raw), &kvs); err != nil {
		return byKey
	}
	for _, kv := range kvs {
		byKey[kv.Key] = kv
	}
	return byKey
}
