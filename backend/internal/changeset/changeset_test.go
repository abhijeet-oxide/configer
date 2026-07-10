package changeset

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/crstore"
	"github.com/abhijeet-oxide/configer/backend/internal/gitengine"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
	"github.com/abhijeet-oxide/configer/backend/internal/transposers"
)

func sh(t *testing.T, dir string, name string, args ...string) string {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v: %v: %s", name, args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// fixture builds a managed repo with a bare origin, mirroring production:
// working clone <-> bare remote.
func fixture(t *testing.T) (workDir string, originDir string, svc *Service) {
	t.Helper()
	root := t.TempDir()
	workDir = filepath.Join(root, "work")
	originDir = filepath.Join(root, "origin.git")

	writeFile(t, filepath.Join(workDir, ".configer", "catalog.yaml"), `
apiVersion: configer.io/v1
kind: ParameterCatalog
metadata: { project: t }
parameters:
  - id: p1
    name: app.port
    category: General
    type: integer
    scope: instance
    source: { file: base/values.yaml, path: $.app.port, format: yaml }
    default: 8080
`)
	writeFile(t, filepath.Join(workDir, ".configer", "instances.yaml"), `
apiVersion: configer.io/v1
kind: InstanceRegistry
metadata: { project: t }
instances:
  - { name: staging, environment: staging, softwareVersion: v1.0.0 }
`)
	writeFile(t, filepath.Join(workDir, ".configer", "instances", "staging", "overlay.yaml"), `
kind: Overlay
instance: staging
values: { p1: 8080 }
`)

	repo, err := gitengine.EnsureRepo(workDir, "Configer Bot", "bot@configer.local")
	if err != nil {
		t.Fatal(err)
	}
	sh(t, root, "git", "init", "--bare", originDir)
	sh(t, workDir, "git", "remote", "add", "origin", originDir)
	sh(t, workDir, "git", "push", "-u", "origin", "main")

	store, err := crstore.New(filepath.Join(workDir, ".git", "configer", "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	reg := plugin.NewRegistry()
	transposers.Register(reg)
	return workDir, originDir, &Service{Repo: repo, Store: store, Registry: reg}
}

func TestSubmitAndMergePipeline(t *testing.T) {
	workDir, originDir, svc := fixture(t)
	ctx := context.Background()

	// Stage a draft with one edit.
	cr, err := svc.Store.Draft("alice@example.com", "main")
	if err != nil {
		t.Fatal(err)
	}
	cr.UpsertItem(change.Item{ParamID: "p1", Instance: "staging", Old: 8080, New: 9443, UpdatedAt: time.Now()})

	// Submit: branch + commit + push.
	got, err := svc.Submit(ctx, cr.ID, "Bump staging port", "Rollout of the new listener", "alice@example.com", "JIRA-42", "feature")
	if err != nil {
		t.Fatal(err)
	}
	if got.State != change.StateUnderReview {
		t.Fatalf("state = %s, want under_review", got.State)
	}
	if got.Branch == "" || got.CommitSHA == "" || got.BaseSHA == "" {
		t.Fatalf("missing git metadata: %+v", got)
	}

	// The CR branch must exist on the origin with the overlay change and the
	// commit must carry the Changed-by trailer.
	names := sh(t, originDir, "git", "branch", "--list")
	if !strings.Contains(names, got.Branch) {
		t.Fatalf("branch %s not on origin: %s", got.Branch, names)
	}
	msg := sh(t, originDir, "git", "log", "-1", "--format=%B", got.Branch)
	if !strings.Contains(msg, "Changed-by: alice@example.com") {
		t.Errorf("commit message missing attribution:\n%s", msg)
	}
	overlay := sh(t, originDir, "git", "show", got.Branch+":.configer/instances/staging/overlay.yaml")
	if !strings.Contains(overlay, "9443") {
		t.Errorf("overlay on CR branch missing new value:\n%s", overlay)
	}
	// generated/ must be rendered on the branch (flux transposer output).
	gen := sh(t, originDir, "git", "show", got.Branch+":generated/staging/flux/helmrelease.yaml")
	if !strings.Contains(gen, "app.port: 9443") {
		t.Errorf("generated flux artifact not rendered:\n%s", gen)
	}

	// The primary tree must be untouched until publish.
	work, _ := os.ReadFile(filepath.Join(workDir, ".configer", "instances", "staging", "overlay.yaml"))
	if strings.Contains(string(work), "9443") {
		t.Error("primary tree changed before publish")
	}

	// Merge: publish to main, push to origin.
	pub, err := svc.Merge(ctx, cr.ID)
	if err != nil {
		t.Fatal(err)
	}
	if pub.State != change.StatePublished {
		t.Fatalf("state = %s, want published", pub.State)
	}
	mainOverlay := sh(t, originDir, "git", "show", "main:.configer/instances/staging/overlay.yaml")
	if !strings.Contains(mainOverlay, "9443") {
		t.Errorf("origin main missing published value:\n%s", mainOverlay)
	}
	work2, _ := os.ReadFile(filepath.Join(workDir, ".configer", "instances", "staging", "overlay.yaml"))
	if !strings.Contains(string(work2), "9443") {
		t.Error("primary tree not updated after publish")
	}
}

func TestRejectDraftAndSubmitted(t *testing.T) {
	_, _, svc := fixture(t)
	ctx := context.Background()

	// Draft rejection deletes it.
	cr, _ := svc.Store.Draft("bob", "main")
	cr.UpsertItem(change.Item{ParamID: "p1", Instance: "staging", Old: 8080, New: 9000})
	if _, err := svc.Reject(ctx, cr.ID); err != nil {
		t.Fatal(err)
	}
	if svc.Store.CurrentDraft() != nil {
		t.Error("draft should be deleted after reject")
	}

	// Submitted CR rejection keeps the record with state rejected.
	cr2, _ := svc.Store.Draft("bob", "main")
	cr2.UpsertItem(change.Item{ParamID: "p1", Instance: "staging", Old: 8080, New: 9001})
	sub, err := svc.Submit(ctx, cr2.ID, "t", "", "bob", "", "")
	if err != nil {
		t.Fatal(err)
	}
	rej, err := svc.Reject(ctx, sub.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rej.State != change.StateRejected {
		t.Fatalf("state = %s, want rejected", rej.State)
	}
}

func TestSubmitValidation(t *testing.T) {
	_, _, svc := fixture(t)
	ctx := context.Background()
	// Empty draft cannot be submitted.
	cr, _ := svc.Store.Draft("bob", "main")
	if _, err := svc.Submit(ctx, cr.ID, "t", "", "bob", "", ""); err == nil {
		t.Error("expected error submitting empty draft")
	}
}
