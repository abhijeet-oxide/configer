package api

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/grid"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// benchFleet writes a synthetic estate: `insts` instances, each with a
// values.yaml carrying `params` keys bound per-instance. This is the shape the
// grid pays for - one file per instance, every one of them parsed to build the
// matrix.
func benchFleet(tb testing.TB, insts, params int) *project.Project {
	root := tb.TempDir()
	cat := model.Catalog{}
	reg := model.InstanceRegistry{}
	for p := 0; p < params; p++ {
		cat.Parameters = append(cat.Parameters, model.Parameter{
			ID:    fmt.Sprintf("p%d", p),
			Name:  fmt.Sprintf("k%d", p),
			Type:  model.TypeString,
			Scope: model.ScopeInstance,
			Bindings: []model.Binding{{
				File: "instances/{instance}/values.yaml", Path: fmt.Sprintf("$.k%d", p), Format: "yaml",
			}},
		})
	}
	for i := 0; i < insts; i++ {
		name := fmt.Sprintf("inst%d", i)
		reg.Instances = append(reg.Instances, model.Instance{Name: name, Folder: "instances/" + name})
		dir := filepath.Join(root, "instances", name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			tb.Fatal(err)
		}
		f, _ := os.Create(filepath.Join(dir, "values.yaml"))
		for p := 0; p < params; p++ {
			fmt.Fprintf(f, "k%d: value-%d-%d\n", p, i, p)
		}
		_ = f.Close()
	}
	return &project.Project{Root: root, Catalog: cat, Registry: reg}
}

// BenchmarkGridUncached is the old read path: every request re-reads and
// re-parses every bound file in the repository.
func BenchmarkGridUncached(b *testing.B) {
	p := benchFleet(b, 150, 200)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if g := grid.Build(p); len(g.Rows) != 200 {
			b.Fatalf("rows=%d", len(g.Rows))
		}
	}
}

// BenchmarkGridCached is the same read through the shared document cache, with
// the tree unchanged between requests - the ordinary case, since people read
// far more often than they write.
func BenchmarkGridCached(b *testing.B) {
	p := benchFleet(b, 150, 200)
	c := newTreeCache(p.Root)
	docs := c.docsAt(0)
	grid.BuildWith(p, docs) // warm, as a running server would be
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if g := grid.BuildWith(p, docs); len(g.Rows) != 200 {
			b.Fatalf("rows=%d", len(g.Rows))
		}
	}
}
