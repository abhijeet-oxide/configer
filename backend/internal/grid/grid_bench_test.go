package grid

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// benchProject writes a synthetic repo: `insts` instances, each with a
// values.yaml carrying `params` keys, and a catalog binding each key
// per-instance. This is the shape that used to re-parse each file once per
// (param, instance) cell.
func benchProject(tb testing.TB, insts, params int) *project.Project {
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
		f.Close()
	}
	return &project.Project{Root: root, Catalog: cat, Registry: reg}
}

func BenchmarkBuildLarge(b *testing.B) {
	p := benchProject(b, 8, 600) // 8 instances x 600 params = 4800 cells
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		g := Build(p)
		if len(g.Rows) != 600 {
			b.Fatalf("rows=%d", len(g.Rows))
		}
	}
}
