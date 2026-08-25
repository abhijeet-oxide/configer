package api

// The YANG model set a repository ships, cached for as long as the working
// tree behind it has not moved.
//
// Loading is not cheap - a telco product ships several hundred modules, and
// every one of them is parsed, resolved through its typedef chains and indexed.
// Doing that per request would make the status panel alone slower than the
// grid. It is a pure function of the files on disk, so it is memoized under the
// same write generation the parsed-tree cache uses: Configer's own writes drop
// it, and a pull that changes the models advances the generation too.

import (
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/productmeta"
	"github.com/abhijeet-oxide/configer/backend/internal/yangschema"
)

// modelCache memoizes one repository's loaded model set.
type modelCache struct {
	mu      sync.Mutex
	gen     uint64
	loaded  bool
	set     *yangschema.Set
	dirs    []string
	version string
}

// models returns the YANG models this application's instances were built
// against, the repo-relative directories they came from, and the release that
// selected them. Every result may be empty: a repository that ships no models
// is the ordinary case, not a failure.
func (s *Server) models() (*yangschema.Set, []string, string) {
	gen := s.treeMu.Gen()
	s.modelsCache.mu.Lock()
	defer s.modelsCache.mu.Unlock()
	if s.modelsCache.loaded && s.modelsCache.gen >= gen {
		return s.modelsCache.set, s.modelsCache.dirs, s.modelsCache.version
	}
	dirs := yangschema.FindSchemaRoots(s.RepoPath)
	version := s.modelVersion()
	var set *yangschema.Set
	selected := dirs
	if len(dirs) > 0 {
		selected = yangschema.ForVersion(dirs, version)
		set = yangschema.LoadWith(s.RepoPath, selected, yangschema.LoadOptions{Features: declaredFeatures()})
		if set.Empty() {
			set = nil
		}
	}
	if gen < s.modelsCache.gen {
		gen = s.modelsCache.gen
	}
	s.modelsCache.gen, s.modelsCache.loaded = gen, true
	s.modelsCache.set, s.modelsCache.dirs, s.modelsCache.version = set, selected, version
	return set, selected, version
}

// modelVersion is the software release the models are chosen for: whatever the
// instances say they are running. They are read from the catalog first and from
// the product descriptors in the repository second, because an operator who has
// set a version explicitly means it.
func (s *Server) modelVersion() string {
	if p, err := s.load(); err == nil {
		for _, inst := range p.Registry.Instances {
			if inst.SoftwareVersion != "" {
				return inst.SoftwareVersion
			}
		}
		for _, inst := range p.Registry.Instances {
			if d, found := productmeta.ForFolder(s.RepoPath, inst.FolderOrDefault()); found && d.Version != "" {
				return d.Version
			}
		}
	}
	return ""
}

// declaredFeatures reads the YANG features this deployment says its build
// supports. Nothing in a repository states them, so unless an operator says
// otherwise every feature counts as enabled - see yangschema.LoadOptions.
func declaredFeatures() []string {
	raw := strings.TrimSpace(os.Getenv("CONFIGER_YANG_FEATURES"))
	if raw == "" {
		return nil
	}
	var out []string
	for _, f := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' }) {
		if f = strings.TrimSpace(f); f != "" {
			out = append(out, f)
		}
	}
	return out
}

// modelFileCount counts the .yang files behind a set, which is the number an
// operator recognizes ("we ship 412 modules") where "3140 data nodes" is a
// number only this program cares about.
func modelFileCount(root string, dirs []string) int {
	n := 0
	for _, d := range dirs {
		entries, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(d)))
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() && strings.EqualFold(filepath.Ext(e.Name()), ".yang") {
				n++
			}
		}
	}
	return n
}

// locator builds the (file, path) -> parameter lookup a finding needs to land
// on the row somebody actually edited rather than on a path in a file.
//
// Two spellings have to agree for that to work. A catalog binding addresses a
// keyed list entry by its identity ("env[name=LOG_LEVEL].value") while a
// document walk addresses it by position ("env[0].value"), and the same value
// is meant. So an exact match is tried first and a positionless, selectorless
// form second - close enough to identify the setting, never used to decide
// anything about it.
func (s *Server) locator() func(file, path string) (string, string, bool) {
	p, err := s.load()
	if err != nil {
		return nil
	}
	type hit struct{ id, name string }
	exact := map[string]hit{}
	loose := map[string]hit{}
	for _, param := range p.Catalog.Parameters {
		display := param.DisplayName
		if display == "" {
			display = param.Name
		}
		h := hit{id: param.ID, name: display}
		for _, b := range param.Bindings {
			record := func(file, path string) {
				k := file + "\x00" + path
				if _, taken := exact[k]; !taken {
					exact[k] = h
				}
				lk := file + "\x00" + loosePath(path)
				if _, taken := loose[lk]; !taken {
					loose[lk] = h
				}
			}
			if strings.Contains(b.File, "{folder}") || strings.Contains(b.File, "{instance}") {
				for _, inst := range p.Registry.Instances {
					record(b.ForInstance(inst).File, b.Path)
				}
				continue
			}
			record(b.File, b.Path)
		}
	}
	return func(file, path string) (string, string, bool) {
		if h, found := exact[file+"\x00"+path]; found {
			return h.id, h.name, true
		}
		if h, found := loose[file+"\x00"+loosePath(path)]; found {
			return h.id, h.name, true
		}
		return "", "", false
	}
}

// loosePath strips every bracketed selector or index from a path, so the two
// ways of addressing one list entry reduce to the same string.
func loosePath(path string) string {
	var b strings.Builder
	depth := 0
	for i := 0; i < len(path); i++ {
		switch path[i] {
		case '[':
			depth++
		case ']':
			if depth > 0 {
				depth--
			}
		default:
			if depth == 0 {
				b.WriteByte(path[i])
			}
		}
	}
	return b.String()
}

// instanceOf returns the instance a repo-relative file belongs to, empty for a
// file shared by all of them.
func instanceOf(instances []model.Instance, file string) string {
	best, bestLen := "", 0
	for _, inst := range instances {
		folder := inst.FolderOrDefault()
		if folder == "" {
			continue
		}
		if strings.HasPrefix(file, folder+"/") && len(folder) > bestLen {
			best, bestLen = inst.Name, len(folder)
		}
	}
	return best
}
