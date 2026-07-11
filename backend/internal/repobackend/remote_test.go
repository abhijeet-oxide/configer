package repobackend

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/remoterepo"
)

// ghStub is a compact in-memory GitHub Git-data-API for exercising
// RemoteBackend end to end (materialize, partial CR commit, working commit,
// merge, refresh) with no real network and no clone.
type ghStub struct {
	mu       sync.Mutex
	n        int
	blobs    map[string][]byte
	trees    map[string]map[string]string
	commits  map[string]string
	branches map[string]string
}

func newGHStub(files map[string]string) *ghStub {
	s := &ghStub{
		blobs: map[string][]byte{}, trees: map[string]map[string]string{},
		commits: map[string]string{}, branches: map[string]string{},
	}
	tree := map[string]string{}
	for p, c := range files {
		b := s.next("blob")
		s.blobs[b] = []byte(c)
		tree[p] = b
	}
	t := s.next("tree")
	s.trees[t] = tree
	c := s.next("commit")
	s.commits[c] = t
	s.branches["main"] = c
	return s
}

func (s *ghStub) next(p string) string { s.n++; return p + string(rune('a'+s.n%26)) + itoaN(s.n) }

func itoaN(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func (s *ghStub) server(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		p := r.URL.Path
		enc := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		switch {
		case p == "/repos/o/r":
			enc(map[string]string{"default_branch": "main"})
		case strings.HasPrefix(p, "/repos/o/r/git/ref/heads/"):
			br := strings.TrimPrefix(p, "/repos/o/r/git/ref/heads/")
			sha, ok := s.branches[br]
			if !ok {
				http.Error(w, `{"message":"no ref"}`, 404)
				return
			}
			enc(map[string]any{"object": map[string]string{"sha": sha}})
		case strings.HasPrefix(p, "/repos/o/r/git/trees/"):
			sha := strings.TrimPrefix(p, "/repos/o/r/git/trees/")
			tr := s.trees[s.commits[sha]]
			if tr == nil {
				tr = s.trees[sha]
			}
			var es []map[string]string
			for path, blob := range tr {
				es = append(es, map[string]string{"path": path, "mode": "100644", "type": "blob", "sha": blob})
			}
			enc(map[string]any{"tree": es, "truncated": false})
		case strings.HasPrefix(p, "/repos/o/r/git/blobs/") && r.Method == "GET":
			enc(map[string]string{"content": base64.StdEncoding.EncodeToString(s.blobs[strings.TrimPrefix(p, "/repos/o/r/git/blobs/")]), "encoding": "base64"})
		case p == "/repos/o/r/git/blobs" && r.Method == "POST":
			var in struct{ Content string }
			_ = json.NewDecoder(r.Body).Decode(&in)
			d, _ := base64.StdEncoding.DecodeString(in.Content)
			b := s.next("blob")
			s.blobs[b] = d
			enc(map[string]string{"sha": b})
		case strings.HasPrefix(p, "/repos/o/r/git/commits/"):
			enc(map[string]any{"tree": map[string]string{"sha": s.commits[strings.TrimPrefix(p, "/repos/o/r/git/commits/")]}})
		case p == "/repos/o/r/git/trees" && r.Method == "POST":
			var in struct {
				BaseTree string `json:"base_tree"`
				Tree     []struct {
					Path string  `json:"path"`
					SHA  *string `json:"sha"`
				} `json:"tree"`
			}
			_ = json.NewDecoder(r.Body).Decode(&in)
			m := map[string]string{}
			for k, v := range s.trees[in.BaseTree] {
				m[k] = v
			}
			for _, e := range in.Tree {
				if e.SHA == nil {
					delete(m, e.Path)
				} else {
					m[e.Path] = *e.SHA
				}
			}
			ts := s.next("tree")
			s.trees[ts] = m
			enc(map[string]string{"sha": ts})
		case p == "/repos/o/r/git/commits" && r.Method == "POST":
			var in struct {
				Tree string `json:"tree"`
			}
			_ = json.NewDecoder(r.Body).Decode(&in)
			c := s.next("commit")
			s.commits[c] = in.Tree
			enc(map[string]string{"sha": c})
		case p == "/repos/o/r/git/refs" && r.Method == "POST":
			var in struct{ Ref, SHA string }
			_ = json.NewDecoder(r.Body).Decode(&in)
			s.branches[strings.TrimPrefix(in.Ref, "refs/heads/")] = in.SHA
			enc(map[string]string{"sha": in.SHA})
		case strings.HasPrefix(p, "/repos/o/r/git/refs/heads/") && r.Method == "PATCH":
			br := strings.TrimPrefix(p, "/repos/o/r/git/refs/heads/")
			var in struct{ SHA string }
			_ = json.NewDecoder(r.Body).Decode(&in)
			s.branches[br] = in.SHA
			enc(map[string]string{"sha": in.SHA})
		case p == "/repos/o/r/merges" && r.Method == "POST":
			var in struct{ Base, Head string }
			_ = json.NewDecoder(r.Body).Decode(&in)
			mc := s.next("commit")
			s.commits[mc] = s.commits[s.branches[in.Head]]
			s.branches[in.Base] = mc
			enc(map[string]string{"sha": mc})
		case strings.HasPrefix(p, "/repos/o/r/compare/"):
			spec := strings.TrimPrefix(p, "/repos/o/r/compare/")
			parts := strings.SplitN(spec, "...", 2)
			from, to := s.trees[s.commits[parts[0]]], s.trees[s.commits[parts[1]]]
			var files []map[string]string
			for path, blob := range to {
				if from[path] != blob {
					st := "modified"
					if _, ok := from[path]; !ok {
						st = "added"
					}
					files = append(files, map[string]string{"filename": path, "status": st, "sha": blob})
				}
			}
			for path := range from {
				if _, ok := to[path]; !ok {
					files = append(files, map[string]string{"filename": path, "status": "removed", "sha": ""})
				}
			}
			enc(map[string]any{"files": files})
		default:
			t.Logf("ghStub unhandled %s %s", r.Method, p)
			http.Error(w, `{"message":"unhandled"}`, 400)
		}
	}))
}

func TestRemoteBackendCRAndWorking(t *testing.T) {
	stub := newGHStub(map[string]string{
		"base/values.yaml":       "network:\n  port: 8080\n",
		".configer/catalog.yaml": "parameters: []\n",
	})
	srv := stub.server(t)
	defer srv.Close()
	client := &remoterepo.Client{Owner: "o", Repo: "r", Token: "t", HTTP: srv.Client(), BaseURL: srv.URL, Name: "Bot", Email: "b@x"}
	ctx := context.Background()

	cache := t.TempDir()
	b, err := NewRemote(ctx, client, "main", cache, nil)
	if err != nil {
		t.Fatalf("NewRemote: %v", err)
	}
	if b.Kind() != "remote" {
		t.Fatalf("kind = %s", b.Kind())
	}
	// materialized read cache reflects the repo, no .git present
	if _, err := os.Stat(filepath.Join(cache, ".git")); !os.IsNotExist(err) {
		t.Fatal("remote cache must have NO .git directory")
	}
	if c, _ := os.ReadFile(filepath.Join(cache, "base/values.yaml")); !strings.Contains(string(c), "8080") {
		t.Fatalf("cache not materialized: %q", c)
	}

	// --- CR write path: OpenCR -> mutate -> Commit (partial commit via API) ---
	base, _ := b.HeadSHA(ctx, "main")
	ws, err := b.OpenCR(ctx, "configer/cr-1", "main")
	if err != nil {
		t.Fatalf("OpenCR: %v", err)
	}
	os.WriteFile(filepath.Join(ws.Dir(), "base/values.yaml"), []byte("network:\n  port: 9090\n"), 0o644)
	_ = os.MkdirAll(filepath.Join(ws.Dir(), "generated/prod"), 0o755)
	os.WriteFile(filepath.Join(ws.Dir(), "generated/prod/out.yaml"), []byte("port: 9090\n"), 0o644)
	sha, err := ws.Commit(ctx, "CR 1")
	ws.Close()
	if err != nil {
		t.Fatalf("CR commit: %v", err)
	}
	if head, _ := b.HeadSHA(ctx, "configer/cr-1"); head != sha {
		t.Fatalf("cr branch head %q != %q", head, sha)
	}
	if head, _ := b.HeadSHA(ctx, "main"); head != base {
		t.Fatal("main moved before publish")
	}

	// --- publish via merges API + cache refresh ---
	if err := b.MergeBranch(ctx, "main", "configer/cr-1", "publish"); err != nil {
		t.Fatalf("MergeBranch: %v", err)
	}
	if c, _ := os.ReadFile(filepath.Join(cache, "base/values.yaml")); !strings.Contains(string(c), "9090") {
		t.Fatalf("cache not refreshed after publish: %q", c)
	}

	// --- catalog write path: mutate the cache, CommitWorking (partial) ---
	os.WriteFile(filepath.Join(cache, ".configer/catalog.yaml"), []byte("parameters:\n  - id: p1\n"), 0o644)
	wsha, committed, err := b.CommitWorking(ctx, "Import p1")
	if err != nil || !committed {
		t.Fatalf("CommitWorking: sha=%q committed=%v err=%v", wsha, committed, err)
	}
	// a second call with no further changes is a no-op
	if _, committed2, _ := b.CommitWorking(ctx, "noop"); committed2 {
		t.Fatal("CommitWorking should be a no-op with no changes")
	}
	// the working commit landed on main
	if head, _ := b.HeadSHA(ctx, "main"); head != wsha {
		t.Fatalf("main head %q != working commit %q", head, wsha)
	}
}
