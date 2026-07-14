package remoterepo

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// stub is an in-memory GitHub Git-data-API good enough to exercise the whole
// no-clone flow: materialize a tree, commit changed paths, refresh via
// compare. Objects are content-addressed by a running counter (the test does
// not care that the shas are not real git shas).
type stub struct {
	mu       sync.Mutex
	n        int
	blobs    map[string][]byte
	trees    map[string]map[string]string // treeSHA -> path -> blobSHA
	commits  map[string]string            // commitSHA -> treeSHA
	parents  map[string]string            // commitSHA -> parent
	branches map[string]string            // branch -> commitSHA
}

func newStub() *stub {
	return &stub{
		blobs: map[string][]byte{}, trees: map[string]map[string]string{},
		commits: map[string]string{}, parents: map[string]string{}, branches: map[string]string{},
	}
}

func (s *stub) id(prefix string) string { s.n++; return fmt.Sprintf("%s%d", prefix, s.n) }

// seed creates an initial commit on main with the given files.
func (s *stub) seed(files map[string]string) {
	tree := map[string]string{}
	for p, content := range files {
		b := s.id("blob")
		s.blobs[b] = []byte(content)
		tree[p] = b
	}
	t := s.id("tree")
	s.trees[t] = tree
	c := s.id("commit")
	s.commits[c] = t
	s.branches["main"] = c
}

func (s *stub) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		p := r.URL.Path
		write := func(v any) { _ = json.NewEncoder(w).Encode(v) }

		switch {
		case r.Method == "GET" && p == "/repos/o/r":
			write(map[string]string{"default_branch": "main"})

		case r.Method == "GET" && strings.HasPrefix(p, "/repos/o/r/git/ref/heads/"):
			branch := strings.TrimPrefix(p, "/repos/o/r/git/ref/heads/")
			sha, ok := s.branches[branch]
			if !ok {
				http.Error(w, `{"message":"not found"}`, 404)
				return
			}
			write(map[string]any{"object": map[string]string{"sha": sha}})

		case r.Method == "GET" && strings.HasPrefix(p, "/repos/o/r/git/trees/"):
			sha := strings.TrimPrefix(p, "/repos/o/r/git/trees/")
			tree := s.trees[s.commits[sha]] // accept commit sha or tree sha
			if tree == nil {
				tree = s.trees[sha]
			}
			var entries []map[string]string
			for path, blob := range tree {
				entries = append(entries, map[string]string{"path": path, "mode": "100644", "type": "blob", "sha": blob})
			}
			write(map[string]any{"tree": entries, "truncated": false})

		case r.Method == "GET" && strings.HasPrefix(p, "/repos/o/r/git/blobs/"):
			sha := strings.TrimPrefix(p, "/repos/o/r/git/blobs/")
			write(map[string]string{
				"content":  base64.StdEncoding.EncodeToString(s.blobs[sha]),
				"encoding": "base64",
			})

		case r.Method == "POST" && p == "/repos/o/r/git/blobs":
			var in struct{ Content, Encoding string }
			_ = json.NewDecoder(r.Body).Decode(&in)
			data, _ := base64.StdEncoding.DecodeString(in.Content)
			b := s.id("blob")
			s.blobs[b] = data
			write(map[string]string{"sha": b})

		case r.Method == "GET" && strings.HasPrefix(p, "/repos/o/r/git/commits/"):
			sha := strings.TrimPrefix(p, "/repos/o/r/git/commits/")
			write(map[string]any{"tree": map[string]string{"sha": s.commits[sha]}})

		case r.Method == "POST" && p == "/repos/o/r/git/trees":
			var in struct {
				BaseTree string `json:"base_tree"`
				Tree     []struct {
					Path string  `json:"path"`
					SHA  *string `json:"sha"`
				} `json:"tree"`
			}
			_ = json.NewDecoder(r.Body).Decode(&in)
			merged := map[string]string{}
			for path, blob := range s.trees[in.BaseTree] {
				merged[path] = blob
			}
			for _, e := range in.Tree {
				if e.SHA == nil {
					delete(merged, e.Path)
				} else {
					merged[e.Path] = *e.SHA
				}
			}
			tsha := s.id("tree")
			s.trees[tsha] = merged
			write(map[string]string{"sha": tsha})

		case r.Method == "POST" && p == "/repos/o/r/git/commits":
			var in struct {
				Tree    string   `json:"tree"`
				Parents []string `json:"parents"`
			}
			_ = json.NewDecoder(r.Body).Decode(&in)
			c := s.id("commit")
			s.commits[c] = in.Tree
			if len(in.Parents) > 0 {
				s.parents[c] = in.Parents[0]
			}
			write(map[string]string{"sha": c})

		case r.Method == "POST" && p == "/repos/o/r/git/refs":
			var in struct{ Ref, SHA string }
			_ = json.NewDecoder(r.Body).Decode(&in)
			s.branches[strings.TrimPrefix(in.Ref, "refs/heads/")] = in.SHA
			write(map[string]string{"sha": in.SHA})

		case r.Method == "PATCH" && strings.HasPrefix(p, "/repos/o/r/git/refs/heads/"):
			branch := strings.TrimPrefix(p, "/repos/o/r/git/refs/heads/")
			var in struct{ SHA string }
			_ = json.NewDecoder(r.Body).Decode(&in)
			s.branches[branch] = in.SHA
			write(map[string]string{"sha": in.SHA})

		case r.Method == "POST" && p == "/repos/o/r/merges":
			var in struct{ Base, Head string }
			_ = json.NewDecoder(r.Body).Decode(&in)
			headSHA := s.branches[in.Head]
			// simple three-way merge: take the head branch's tree wholesale
			// (sufficient for the CR-into-main publish the tests exercise)
			mc := s.id("commit")
			s.commits[mc] = s.commits[headSHA]
			s.parents[mc] = s.branches[in.Base]
			s.branches[in.Base] = mc
			write(map[string]string{"sha": mc})

		case r.Method == "GET" && strings.HasPrefix(p, "/repos/o/r/compare/"):
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
			write(map[string]any{"files": files})

		default:
			t.Logf("stub: unhandled %s %s", r.Method, p)
			http.Error(w, `{"message":"unhandled"}`, 400)
		}
	})
}

func newClient(srv *httptest.Server) *Client {
	return &Client{
		Owner: "o", Repo: "r", Token: "t",
		HTTP: srv.Client(), BaseURL: srv.URL,
		Name: "Configer Bot", Email: "bot@localhost",
	}
}

func TestMaterializeCommitRefresh(t *testing.T) {
	st := newStub()
	st.seed(map[string]string{
		"base/values.yaml":          "network:\n  port: 8080\n",
		".configer/parameters.yaml": "parameters: []\n",
	})
	srv := httptest.NewServer(st.handler(t))
	defer srv.Close()
	c := newClient(srv)
	ctx := context.Background()

	// --- Materialize: partial checkout, no clone ---
	dir := t.TempDir()
	base, err := c.Materialize(ctx, "main", dir)
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "base/values.yaml"))
	if err != nil || !strings.Contains(string(got), "port: 8080") {
		t.Fatalf("materialized file wrong: %q %v", got, err)
	}

	// --- CommitPaths: partial commit through the API onto a new CR branch ---
	// edit a managed file plus add a generated one, all in the local cache
	if err := os.WriteFile(filepath.Join(dir, "base/values.yaml"), []byte("network:\n  port: 9090\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	genDir := filepath.Join(dir, "generated/prod")
	_ = os.MkdirAll(genDir, 0o755)
	if err := os.WriteFile(filepath.Join(genDir, "values.yaml"), []byte("port: 9090\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	commitSHA, err := c.CommitPaths(ctx, "configer/cr-1", base,
		"Bump port\n\nChanged-by: alice\n", dir,
		[]string{"base/values.yaml", "generated/prod/values.yaml"}, nil)
	if err != nil {
		t.Fatalf("commit paths: %v", err)
	}
	if commitSHA == "" {
		t.Fatal("empty commit sha")
	}
	// the CR branch exists and points at the new commit
	if head, _ := c.HeadSHA(ctx, "configer/cr-1"); head != commitSHA {
		t.Fatalf("cr branch head = %q, want %q", head, commitSHA)
	}
	// main is untouched (partial commit went to the branch only)
	if head, _ := c.HeadSHA(ctx, "main"); head != base {
		t.Fatalf("main moved unexpectedly: %q != %q", head, base)
	}

	// --- Merge the CR branch into main (publish) ---
	if _, err := c.Merge(ctx, "main", "configer/cr-1", "Publish CR 1"); err != nil {
		t.Fatalf("merge: %v", err)
	}

	// --- Refresh: a second cache catches up via compare, only changed paths ---
	dir2 := t.TempDir()
	from, err := c.Materialize(ctx, "main", dir2)
	if err != nil {
		t.Fatalf("materialize dir2: %v", err)
	}
	// commit another change on main directly (simulate an external edit)
	if err := os.WriteFile(filepath.Join(dir2, "base/values.yaml"), []byte("network:\n  port: 7000\n"), 0o644); err != nil {
		t.Fatalf("write values: %v", err)
	}
	newBase, _ := c.HeadSHA(ctx, "main")
	if _, err := c.CommitPaths(ctx, "main", newBase, "external", dir2, []string{"base/values.yaml"}, nil); err != nil {
		t.Fatalf("external commit: %v", err)
	}
	// dir2 is stale at `from`; refresh should bring only values.yaml forward
	refreshed, err := c.Refresh(ctx, "main", from, dir2)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if refreshed == from {
		t.Fatal("refresh did not advance")
	}
	got2, _ := os.ReadFile(filepath.Join(dir2, "base/values.yaml"))
	if !strings.Contains(string(got2), "port: 7000") {
		t.Fatalf("refresh did not update the file: %q", got2)
	}
}

func TestCommitPathsDeletion(t *testing.T) {
	st := newStub()
	st.seed(map[string]string{"a.txt": "one", "b.txt": "two"})
	srv := httptest.NewServer(st.handler(t))
	defer srv.Close()
	c := newClient(srv)
	ctx := context.Background()

	dir := t.TempDir()
	base, err := c.Materialize(ctx, "main", dir)
	if err != nil {
		t.Fatal(err)
	}
	// delete b.txt through a commit (no path in dir needed for a delete)
	if _, err := c.CommitPaths(ctx, "main", base, "drop b", dir, nil, []string{"b.txt"}); err != nil {
		t.Fatalf("commit delete: %v", err)
	}
	dir2 := t.TempDir()
	if _, err := c.Materialize(ctx, "main", dir2); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir2, "b.txt")); !os.IsNotExist(err) {
		t.Fatalf("b.txt should be gone after the delete commit")
	}
	if _, err := os.Stat(filepath.Join(dir2, "a.txt")); err != nil {
		t.Fatalf("a.txt should survive: %v", err)
	}
}
