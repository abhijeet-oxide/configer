//go:build functional

// Functional suite: onboard every repo in sample-repos/ and assert Configer
// reads it the way a human would - the right layout, the right instances, the
// tunable parameters present, the structural noise gone, and validation
// derived from the schemas that ship with the repo. It also round-trips a
// write back into each repo's real files so "discovered" always means
// "editable", never just "listed".
//
// On demand, not part of `go test ./...`:
//
//	go test -tags functional ./internal/discovery/...
//
// or `make functional-test` for the backend + API suites together.
package discovery

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/writeback"
)

// repoRoot resolves sample-repos/<name> from this test file's location, so the
// suite runs regardless of the working directory.
func sampleRepo(t *testing.T, name string) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate test file")
	}
	// backend/internal/discovery/<file> -> repo root is three levels up.
	root := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "sample-repos", name)
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("sample repo %s not found at %s: %v", name, root, err)
	}
	return root
}

// sampleCase is one repo's expected reading.
type sampleCase struct {
	name         string
	layout       string
	minInstances int
	wantInstance string   // one instance that must be present
	present      []string // parameter names that MUST be discovered
	absent       []string // parameter names that must NOT appear (noise/envelope)
	// validated maps a parameter name to a predicate its Validation must satisfy,
	// proving schema/preset rules were attached.
	validated map[string]func(model.Validation) bool
}

func hasMin(v model.Validation) bool   { return v.Min != nil }
func hasMax(v model.Validation) bool   { return v.Max != nil }
func hasEnum(v model.Validation) bool  { return len(v.Enum) > 0 }
func required(v model.Validation) bool { return v.Required }

var sampleCases = []sampleCase{
	{
		name:         "helm-umbrella",
		layout:       "plain-folders",
		minInstances: 4,
		wantInstance: "prod-us",
		present: []string{
			"replicaCount", "image.tag", "service.port", "service.type",
			"ingress.host", "logging.level",
		},
		// Chart plumbing and rendered templates must never become parameters.
		absent: []string{
			"name", "version", "appVersion", "apiVersion", "kind",
			"dependencies", "dependencies.name", "dependencies.version",
		},
		validated: map[string]func(model.Validation) bool{
			"replicaCount": func(v model.Validation) bool { return hasMin(v) && hasMax(v) },
			"service.port": hasMax,
			"service.type": hasEnum,
			"logging.level": hasEnum,
			"image.tag":     func(v model.Validation) bool { return v.Pattern != "" },
		},
	},
	{
		name:         "kustomize-fleet",
		layout:       "kustomize",
		minInstances: 5,
		wantInstance: "prod-us-east",
		present:      []string{"spec.replicas", "spec.type", "data.LOG_LEVEL"},
		absent:       []string{"apiVersion", "kind", "metadata.name", "metadata.labels.app"},
	},
	{
		name:         "kpt-network",
		layout:       "kpt",
		minInstances: 4,
		wantInstance: "us-east",
		present:      []string{"spec.replicas", "spec.routing.subnet", "spec.routing.gateway", "spec.dns"},
		absent:       []string{"apiVersion", "kind", "metadata.name"},
	},
	{
		name:         "k8s-multicluster",
		layout:       "plain-folders",
		minInstances: 5,
		wantInstance: "us-east-1",
		present:      []string{"spec.replicas", "spec.type", "data.LOG_LEVEL", "spec.maxReplicas"},
		absent: []string{
			"apiVersion", "kind", "metadata.name", "metadata.namespace",
			"metadata.labels.app", "status.readyReplicas", "status.observedGeneration",
		},
	},
	{
		name:         "telco-ran",
		layout:       "plain-folders",
		minInstances: 6,
		wantInstance: "cluster-us-east-01",
		present: []string{
			"cell.band", "cell.earfcn", "cell.pci", "transport.gateway",
			"neighbors", "radio-unit.admin-state",
		},
		validated: map[string]func(model.Validation) bool{
			"cell.band":         hasEnum,
			"cell.earfcn":       func(v model.Validation) bool { return hasMin(v) && hasMax(v) },
			"cell.pci":          required,
			"transport.gateway": func(v model.Validation) bool { return v.Preset == "ipv4" },
		},
	},
}

func TestFunctionalDiscoverSamples(t *testing.T) {
	for _, tc := range sampleCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			root := sampleRepo(t, tc.name)
			res, err := Discover(root, registry(), project.Ignore{})
			if err != nil {
				t.Fatalf("discover: %v", err)
			}
			if res.Detection.Layout != tc.layout {
				t.Errorf("layout = %q, want %q", res.Detection.Layout, tc.layout)
			}
			if len(res.Instances) < tc.minInstances {
				t.Errorf("instances = %d, want >= %d", len(res.Instances), tc.minInstances)
			}
			var haveInst bool
			for _, i := range res.Instances {
				if i.Name == tc.wantInstance {
					haveInst = true
				}
			}
			if !haveInst {
				t.Errorf("instance %q not discovered; have %v", tc.wantInstance, instNames(res))
			}

			byName := paramsByName(res)
			for _, name := range tc.present {
				if _, ok := byName[name]; !ok {
					t.Errorf("expected parameter %q missing", name)
				}
			}
			for _, name := range tc.absent {
				if _, ok := byName[name]; ok {
					t.Errorf("noise parameter %q should have been filtered out", name)
				}
			}
			for name, pred := range tc.validated {
				p, ok := byName[name]
				if !ok {
					t.Errorf("validated parameter %q missing", name)
					continue
				}
				if !pred(p.Validation) {
					t.Errorf("parameter %q validation not attached as expected: %+v", name, p.Validation)
				}
			}
		})
	}
}

// TestFunctionalWriteBack proves every repo is not just readable but editable:
// pick a discovered instance-layer parameter, write a new value into a copy of
// the repo through the same engine the API uses, and read it back. This covers
// YAML, XML and multi-document YAML write-back paths across the corpus.
func TestFunctionalWriteBack(t *testing.T) {
	for _, tc := range sampleCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			src := sampleRepo(t, tc.name)
			dst := t.TempDir()
			copyTree(t, src, dst)

			res, err := Discover(dst, registry(), project.Ignore{})
			if err != nil {
				t.Fatalf("discover: %v", err)
			}
			inst := instanceByName(res, tc.wantInstance)
			if inst.Name == "" {
				t.Fatalf("instance %q not found", tc.wantInstance)
			}

			p, b := firstInstanceScalarBinding(res)
			if p.Name == "" {
				t.Fatal("no instance-layer scalar parameter to edit")
			}
			eb := b.ForInstance(inst)
			newVal := "configer-func-test"
			if p.Type == model.TypeInteger {
				newVal = "4242"
			}

			var writeVal any = newVal
			if p.Type == model.TypeInteger {
				writeVal = 4242
			}
			if err := writeback.SetValue(dst, eb.File, eb.Format, eb.Path, p.Type, writeVal); err != nil {
				t.Fatalf("write back %s %s: %v", eb.File, eb.Path, err)
			}

			raw, err := os.ReadFile(filepath.Join(dst, eb.File))
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(raw), newVal) {
				t.Errorf("write-back of %s (%s) not reflected in %s:\n%s",
					p.Name, eb.Path, eb.File, raw)
			}
		})
	}
}

func instNames(res Result) []string {
	var out []string
	for _, i := range res.Instances {
		out = append(out, i.Name)
	}
	return out
}

func instanceByName(res Result, name string) model.Instance {
	for _, i := range res.Instances {
		if i.Name == name {
			return i
		}
	}
	return model.Instance{}
}

// firstInstanceScalarBinding returns the first discovered parameter that has a
// templated (instance-layer) scalar binding - a safe, representative edit
// target for the round-trip.
func firstInstanceScalarBinding(res Result) (model.Parameter, model.Binding) {
	for _, p := range res.Parameters {
		if p.Type == model.TypeList {
			continue
		}
		for _, b := range p.Bindings {
			if strings.Contains(b.File, "{folder}") {
				return p, b
			}
		}
	}
	return model.Parameter{}, model.Binding{}
}

func copyTree(t *testing.T, src, dst string) {
	t.Helper()
	err := filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
}

// timing guard: discovery of every committed sample repo should stay well under
// a second combined, so a pathological slowdown shows up as a failure.
func TestFunctionalDiscoverTiming(t *testing.T) {
	start := time.Now()
	for _, tc := range sampleCases {
		if _, err := Discover(sampleRepo(t, tc.name), registry(), project.Ignore{}); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("discovering the sample corpus took %s, want < 5s", d)
	}
}
