// Package sources holds Configer's built-in external-source providers: plugins
// that fetch key/value pairs from systems OUTSIDE the managed repository (a
// different Git repository, a secret store) so a managed parameter can be
// mapped to an upstream value. Each provider implements plugin.SourceProvider
// and registers at startup; adding a new source kind means adding a file here,
// never touching the core.
package sources

import (
	"context"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/gitengine"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/provider"
	"github.com/abhijeet-oxide/configer/backend/internal/remoterepo"
)

// gitSource pulls parameter values from a config file (or folder of config
// files) in another Git repository. It reads the repo at a branch WITHOUT a
// working checkout for github.com URLs (the Git data API), and by a shallow
// clone to a temp dir for any other URL or a local path. Values come straight
// from the file, so they are non-secret.
type gitSource struct {
	// reg supplies the format parsers (yaml/json/xml) that turn a fetched file
	// into typed key/value candidates - the same parsers onboarding uses.
	reg *plugin.Registry
}

func (g gitSource) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID:          "git",
		Name:        "Git repository",
		Version:     "1.0.0",
		Kind:        plugin.KindSource,
		Description: "Pull parameter values from a YAML/JSON/XML file in another Git repository (branch, folder and file selectable).",
		Icon:        "git",
		Color:       "orange",
		Category:    "Version control",
	}
}

func (g gitSource) Fields() []plugin.SourceField {
	return []plugin.SourceField{
		{Key: "repoUrl", Label: "Repository URL", Type: "text", Required: true,
			Help: "https URL of the source repository (e.g. https://github.com/acme/platform-defaults)."},
		{Key: "branch", Label: "Branch", Type: "branch", Required: false,
			Help: "Branch to read from. Defaults to the repository's default branch."},
		{Key: "path", Label: "File or folder", Type: "path", Required: false,
			Help: "A config file to read, or a folder whose config files are all read. Blank reads the repository root."},
	}
}

// Fetch reads the configured file(s) and returns their key/value pairs. When
// the path is a single file, keys are the file's dotted paths; when it is a
// folder, keys are prefixed with the child file path so they stay unique.
func (g gitSource) Fetch(ctx context.Context, cfg plugin.SourceConfig) ([]plugin.SourceKV, error) {
	rd, err := g.open(ctx, cfg)
	if err != nil {
		return nil, err
	}
	defer rd.close()

	target := strings.Trim(cfg.Get("path"), "/")
	files, single := filesUnder(rd.paths(), target)
	var out []plugin.SourceKV
	for _, f := range files {
		content, rerr := rd.read(f)
		if rerr != nil {
			return nil, rerr
		}
		parser, perr := g.reg.ParserFor(f, content)
		if perr != nil {
			continue // not a config file we can read
		}
		cands, xerr := parser.Extract(f, content)
		if xerr != nil {
			return nil, fmt.Errorf("read %s: %w", f, xerr)
		}
		for _, c := range cands {
			key := c.Path
			if !single {
				// Disambiguate identical dotted paths across files in a folder.
				rel := strings.TrimPrefix(strings.TrimPrefix(f, target), "/")
				key = rel + "#" + c.Path
			}
			out = append(out, plugin.SourceKV{Key: key, Value: c.Value, Type: c.Type})
		}
	}
	return out, nil
}

// Browse lists the immediate children (folders and config files) under path,
// so the UI can drill into the source repository.
func (g gitSource) Browse(ctx context.Context, cfg plugin.SourceConfig, browsePath string) ([]plugin.BrowseEntry, error) {
	rd, err := g.open(ctx, cfg)
	if err != nil {
		return nil, err
	}
	defer rd.close()
	return children(rd.paths(), strings.Trim(browsePath, "/")), nil
}

// open resolves the source into a gitReader (remote data API or temp clone).
func (g gitSource) open(ctx context.Context, cfg plugin.SourceConfig) (gitReader, error) {
	url := strings.TrimSpace(cfg.Get("repoUrl"))
	if url == "" {
		return nil, fmt.Errorf("a repository URL is required")
	}
	branch := strings.TrimSpace(cfg.Get("branch"))
	if _, _, ok := provider.ParseGitHubOrigin(url); ok {
		return newRemoteReader(ctx, url, branch, cfg.Secret)
	}
	return newLocalReader(url, branch, cfg.Secret)
}

// gitReader abstracts reading a repository's tree and file bytes, so the same
// Fetch/Browse logic serves both the no-clone GitHub path and the temp-clone
// path.
type gitReader interface {
	// paths returns every file path in the repository (slash-separated).
	paths() []string
	read(file string) ([]byte, error)
	close()
}

// filesUnder returns the config files to read for target and whether target
// named a single file. An empty target (or a folder) yields the immediate
// config files inside it.
func filesUnder(all []string, target string) ([]string, bool) {
	// Single file: exact match.
	for _, p := range all {
		if p == target {
			return []string{p}, true
		}
	}
	var out []string
	for _, p := range all {
		if target != "" && !strings.HasPrefix(p, target+"/") {
			continue
		}
		rel := strings.TrimPrefix(p, strings.TrimSuffix(target+"/", "/"))
		rel = strings.TrimPrefix(rel, "/")
		if strings.Contains(rel, "/") {
			continue // not an immediate child
		}
		if isConfigFile(p) {
			out = append(out, p)
		}
	}
	return out, false
}

// children lists the immediate folders and config files under target.
func children(all []string, target string) []plugin.BrowseEntry {
	seenDir := map[string]bool{}
	var out []plugin.BrowseEntry
	prefix := ""
	if target != "" {
		prefix = target + "/"
	}
	for _, p := range all {
		if !strings.HasPrefix(p, prefix) {
			continue
		}
		rel := strings.TrimPrefix(p, prefix)
		if rel == "" {
			continue
		}
		if i := strings.IndexByte(rel, '/'); i >= 0 {
			dir := rel[:i]
			full := prefix + dir
			if !seenDir[full] {
				seenDir[full] = true
				out = append(out, plugin.BrowseEntry{Name: dir, Path: full, IsDir: true})
			}
			continue
		}
		if isConfigFile(p) {
			out = append(out, plugin.BrowseEntry{Name: rel, Path: p})
		}
	}
	return out
}

func isConfigFile(p string) bool {
	switch strings.ToLower(path.Ext(p)) {
	case ".yaml", ".yml", ".json", ".xml":
		return true
	}
	return false
}

// --- remote reader (github.com, no clone) ------------------------------------

type remoteReader struct {
	byPath map[string]string // path -> blob sha
	order  []string
	client *remoterepo.Client
	ctx    context.Context
}

func newRemoteReader(ctx context.Context, url, branch, token string) (gitReader, error) {
	client, err := remoterepo.New(url, token, "Configer Bot", "configer-bot@localhost")
	if err != nil {
		return nil, err
	}
	if branch == "" {
		if branch, err = client.DefaultBranch(ctx); err != nil {
			return nil, err
		}
	}
	sha, err := client.HeadSHA(ctx, branch)
	if err != nil {
		return nil, fmt.Errorf("resolve branch %q: %w", branch, err)
	}
	entries, err := client.Tree(ctx, sha)
	if err != nil {
		return nil, err
	}
	r := &remoteReader{byPath: map[string]string{}, client: client, ctx: ctx}
	for _, e := range entries {
		if e.Type == "blob" {
			r.byPath[e.Path] = e.SHA
			r.order = append(r.order, e.Path)
		}
	}
	return r, nil
}

func (r *remoteReader) paths() []string { return r.order }
func (r *remoteReader) read(file string) ([]byte, error) {
	sha, ok := r.byPath[file]
	if !ok {
		return nil, fmt.Errorf("file %q not found in source", file)
	}
	return r.client.Blob(r.ctx, sha)
}
func (r *remoteReader) close() {}

// --- local reader (temp clone) -----------------------------------------------

type localReader struct {
	root  string
	order []string
	temp  bool
}

func newLocalReader(url, branch, token string) (gitReader, error) {
	dir, err := os.MkdirTemp("", "configer-source-")
	if err != nil {
		return nil, err
	}
	repoDir := filepath.Join(dir, "repo")
	if _, err := gitengine.Clone(url, repoDir, branch, token, "Configer Bot", "configer-bot@localhost"); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	r := &localReader{root: repoDir, temp: true}
	_ = filepath.WalkDir(repoDir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		rel, rerr := filepath.Rel(repoDir, p)
		if rerr == nil {
			r.order = append(r.order, filepath.ToSlash(rel))
		}
		return nil
	})
	return r, nil
}

func (r *localReader) paths() []string { return r.order }
func (r *localReader) read(file string) ([]byte, error) {
	return os.ReadFile(filepath.Join(r.root, filepath.FromSlash(file)))
}
func (r *localReader) close() {
	if r.temp {
		_ = os.RemoveAll(filepath.Dir(r.root))
	}
}
