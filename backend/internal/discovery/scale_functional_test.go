//go:build functional

// Scale suite: generate a repository the size of a real fleet - many instances,
// each with a large parameter surface across YAML and XML - and assert the
// scanner still reads it correctly and quickly. Nothing large is committed; the
// tree is built in a temp directory per run.
//
//	go test -tags functional ./internal/discovery/... -run TestScale -v
package discovery

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// generateFleet writes `instances` per-instance folders under instances/, each
// carrying a values.yaml with a fixed schema of `yamlLeaves` leaves and a
// network.xml with a handful of elements. Values vary by instance index so the
// parameters are genuinely instance-scoped (no accidental fleet-wide default).
func generateFleet(t *testing.T, instances, yamlLeaves int) string {
	t.Helper()
	root := t.TempDir()

	// A shared base file, as real fleets have.
	shared := "platform:\n  registry: registry.example.com\n  profile: enterprise\n  domain: fleet.example.com\n"
	mustWrite(t, filepath.Join(root, "shared", "platform.yaml"), shared)

	for i := 0; i < instances; i++ {
		name := fmt.Sprintf("site-%03d", i)
		dir := filepath.Join(root, "instances", name)

		var b []byte
		b = append(b, []byte("global:\n")...)
		b = append(b, []byte(fmt.Sprintf("  namespace: ns-%03d\n", i))...)
		b = append(b, []byte(fmt.Sprintf("  region: region-%d\n", i%5))...)
		b = append(b, []byte("services:\n")...)
		for j := 0; j < yamlLeaves; j++ {
			// A stable key schema across every instance, values that differ by
			// instance, so dedup collapses N instances x M keys into M params.
			b = append(b, []byte(fmt.Sprintf("  svc%02d:\n", j))...)
			b = append(b, []byte(fmt.Sprintf("    port: %d\n", 8000+i*10+j))...)
			b = append(b, []byte(fmt.Sprintf("    replicas: %d\n", 1+(i+j)%9))...)
			b = append(b, []byte("    enabled: true\n")...)
		}
		mustWrite(t, filepath.Join(dir, "values.yaml"), string(b))

		xml := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<config namespace="ns-%03d">
  <gateway>
    <address>10.%d.%d.1</address>
    <prefix>24</prefix>
  </gateway>
</config>
`, i, i%250, (i*7)%250)
		mustWrite(t, filepath.Join(dir, "network.xml"), xml)
	}
	return root
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestScaleDiscovery(t *testing.T) {
	const (
		instances  = 80
		yamlLeaves = 40 // 3 leaves each -> ~120 yaml params + envelope
	)
	root := generateFleet(t, instances, yamlLeaves)

	start := time.Now()
	res, err := Discover(root, registry(), project.Ignore{})
	if err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(start)

	if res.Detection.Layout != "plain-folders" {
		t.Errorf("layout = %s", res.Detection.Layout)
	}
	if len(res.Instances) != instances {
		t.Fatalf("instances = %d, want %d", len(res.Instances), instances)
	}

	// Deduplication is the whole point at scale: the same key schema in every
	// instance must collapse to ONE parameter per key, not one per instance.
	// yamlLeaves*3 service leaves + namespace + region + a couple XML leaves,
	// plus the shared platform.* globals. Assert it is on the order of the key
	// count, NOT instances x keys.
	nParams := len(res.Parameters)
	perInstanceKeys := yamlLeaves*3 + 2 + 3 // yaml leaves + namespace/region + xml
	if nParams > perInstanceKeys*3 {
		t.Errorf("parameter count %d looks un-deduplicated (per-instance keys ~%d, instances %d)",
			nParams, perInstanceKeys, instances)
	}
	if nParams < yamlLeaves { // sanity floor
		t.Errorf("parameter count %d too low", nParams)
	}

	// Every parameter that varies per instance should carry a templated,
	// instance-layer binding (the grid is params x instances).
	var templated int
	for _, p := range res.Parameters {
		for _, b := range p.Bindings {
			if b.EffectiveLayer() == model.LayerInstance {
				templated++
				break
			}
		}
	}
	if templated < yamlLeaves {
		t.Errorf("templated (instance-layer) params = %d, want >= %d", templated, yamlLeaves)
	}

	// The shared file's settings must be discovered as global base params.
	byName := paramsByName(res)
	if p, ok := byName["platform.domain"]; !ok || p.Scope != model.ScopeGlobal {
		t.Errorf("shared platform.domain not discovered as a global parameter")
	}

	t.Logf("scale: %d instances x ~%d keys -> %d parameters in %s",
		instances, perInstanceKeys, nParams, elapsed)
	if elapsed > 15*time.Second {
		t.Errorf("discovery of %d instances took %s, want < 15s", instances, elapsed)
	}
}
