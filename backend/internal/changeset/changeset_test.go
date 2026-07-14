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
	"github.com/abhijeet-oxide/configer/backend/internal/repobackend"
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

// stagingValues is the instance's REAL config file: comments and unmanaged
// keys must survive a write-back byte-for-byte.
const stagingValues = `# Staging values. Hand-maintained comment.
app:
  port: 8080 # the listener
  name: demo
unmanaged: keep-me
`

// fixture builds a write-back-native managed repo with a bare origin,
// mirroring production: working clone <-> bare remote. Values live in the
// instances' own files; .configer holds only metadata.
func fixture(t *testing.T) (workDir string, originDir string, svc *Service) {
	t.Helper()
	root := t.TempDir()
	workDir = filepath.Join(root, "work")
	originDir = filepath.Join(root, "origin.git")

	writeFile(t, filepath.Join(workDir, ".configer", "application.yaml"), `
apiVersion: configer.io/v1
kind: Application
name: t
layout: plain-folders
`)
	writeFile(t, filepath.Join(workDir, ".configer", "parameters.yaml"), `
apiVersion: configer.io/v1
kind: ParameterCatalog
parameters:
  - id: p1
    name: app.port
    category: General
    type: integer
    scope: instance
    bindings:
      - { file: "{folder}/values.yaml", path: $.app.port, format: yaml }
    default: 8080
  - id: p2
    name: platform.domain
    category: General
    type: string
    scope: global
    bindings:
      - { file: shared/platform.yaml, path: $.platform.domain, format: yaml }
`)
	writeFile(t, filepath.Join(workDir, ".configer", "instances.yaml"), `
apiVersion: configer.io/v1
kind: InstanceRegistry
instances:
  - { name: staging, folder: instances/staging, environment: staging, softwareVersion: v1.0.0 }
  - { name: prod, folder: instances/prod, environment: production, softwareVersion: v1.0.0 }
`)
	writeFile(t, filepath.Join(workDir, "instances", "staging", "values.yaml"), stagingValues)
	writeFile(t, filepath.Join(workDir, "instances", "prod", "values.yaml"), "app:\n  port: 8443\n  name: demo\n")
	writeFile(t, filepath.Join(workDir, "shared", "platform.yaml"), "platform:\n  domain: example.com\n")

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
	backend := repobackend.NewLocal(repo, nil)
	return workDir, originDir, &Service{Backend: backend, Store: store}
}

func TestSubmitAndMergePipeline(t *testing.T) {
	workDir, originDir, svc := fixture(t)
	ctx := context.Background()

	// Stage a draft with one per-instance edit and one global edit.
	cr, err := svc.Store.Draft("alice@example.com", "main")
	if err != nil {
		t.Fatal(err)
	}
	cr.UpsertItem(change.Item{ParamID: "p1", Instance: "staging", Old: 8080, New: 9443, UpdatedAt: time.Now()})
	cr.UpsertItem(change.Item{ParamID: "p2", Scope: "global", Old: "example.com", New: "corp.example.com", UpdatedAt: time.Now()})

	// Submit: branch + write-back + commit + push.
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

	// The CR branch must exist on the origin, with the REAL file edited
	// surgically and the commit carrying the Changed-by trailer.
	names := sh(t, originDir, "git", "branch", "--list")
	if !strings.Contains(names, got.Branch) {
		t.Fatalf("branch %s not on origin: %s", got.Branch, names)
	}
	msg := sh(t, originDir, "git", "log", "-1", "--format=%B", got.Branch)
	if !strings.Contains(msg, "Changed-by: alice@example.com") {
		t.Errorf("commit message missing attribution:\n%s", msg)
	}
	values := sh(t, originDir, "git", "show", got.Branch+":instances/staging/values.yaml")
	want := `# Staging values. Hand-maintained comment.
app:
  port: 9443 # the listener
  name: demo
unmanaged: keep-me`
	if strings.TrimSpace(values) != want {
		t.Errorf("write-back not surgical:\n--- got ---\n%s\n--- want ---\n%s", values, want)
	}
	// The other instance's file must be untouched.
	prod := sh(t, originDir, "git", "show", got.Branch+":instances/prod/values.yaml")
	if !strings.Contains(prod, "port: 8443") {
		t.Errorf("prod file must not change:\n%s", prod)
	}
	// The global edit lands in the shared file once.
	shared := sh(t, originDir, "git", "show", got.Branch+":shared/platform.yaml")
	if !strings.Contains(shared, "domain: corp.example.com") {
		t.Errorf("shared file missing global edit:\n%s", shared)
	}
	// Nothing may be generated: the repository's own files are the output.
	tree := sh(t, originDir, "git", "ls-tree", "-r", "--name-only", got.Branch)
	if strings.Contains(tree, "generated/") {
		t.Errorf("generated/ artifacts must not exist:\n%s", tree)
	}

	// The primary tree must be untouched until publish.
	work, _ := os.ReadFile(filepath.Join(workDir, "instances", "staging", "values.yaml"))
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
	mainValues := sh(t, originDir, "git", "show", "main:instances/staging/values.yaml")
	if !strings.Contains(mainValues, "9443") {
		t.Errorf("origin main missing published value:\n%s", mainValues)
	}
	work2, _ := os.ReadFile(filepath.Join(workDir, "instances", "staging", "values.yaml"))
	if !strings.Contains(string(work2), "9443") {
		t.Error("primary tree not updated after publish")
	}
}

func TestSubmitResetRemovesKey(t *testing.T) {
	_, originDir, svc := fixture(t)
	ctx := context.Background()

	cr, _ := svc.Store.Draft("bob", "main")
	cr.UpsertItem(change.Item{ParamID: "p1", Instance: "staging", Action: change.ActionReset, Old: 8080, UpdatedAt: time.Now()})

	got, err := svc.Submit(ctx, cr.ID, "Drop staging port override", "", "bob", "", "")
	if err != nil {
		t.Fatal(err)
	}
	values := sh(t, originDir, "git", "show", got.Branch+":instances/staging/values.yaml")
	if strings.Contains(values, "port:") {
		t.Errorf("reset must remove the key:\n%s", values)
	}
	// Unmanaged content and siblings survive.
	for _, keep := range []string{"name: demo", "unmanaged: keep-me", "# Staging values."} {
		if !strings.Contains(values, keep) {
			t.Errorf("lost %q on reset:\n%s", keep, values)
		}
	}
}

// TestSubmitAddInstance is the git-native instance lifecycle contract: a
// staged add-instance scaffolds the folder ON THE CR BRANCH (copy of the
// clone source), registers the instance, and value edits for the brand-new
// instance land inside the scaffolded folder — one reviewable commit.
func TestSubmitAddInstance(t *testing.T) {
	_, originDir, svc := fixture(t)
	ctx := context.Background()

	cr, _ := svc.Store.Draft("carol", "main")
	cr.UpsertItem(change.Item{
		Instance: "dr",
		Action:   change.ActionAddInstance,
		Old:      "prod", // clone source
		New:      map[string]any{"environment": "production", "region": "us-west"},
	})
	// A value edit for the new instance rides the same CR.
	cr.UpsertItem(change.Item{ParamID: "p1", Instance: "dr", New: 7443, UpdatedAt: time.Now()})

	got, err := svc.Submit(ctx, cr.ID, "Add DR instance", "", "carol", "", "")
	if err != nil {
		t.Fatal(err)
	}

	// The scaffolded folder exists on the branch, cloned from prod, with the
	// value edit applied on top.
	values := sh(t, originDir, "git", "show", got.Branch+":instances/dr/values.yaml")
	if !strings.Contains(values, "port: 7443") {
		t.Errorf("value edit missing in scaffolded instance:\n%s", values)
	}
	if !strings.Contains(values, "name: demo") {
		t.Errorf("clone content missing:\n%s", values)
	}
	// The registry entry carries the metadata and the folder binding.
	reg := sh(t, originDir, "git", "show", got.Branch+":.configer/instances.yaml")
	for _, want := range []string{"name: dr", "folder: instances/dr", "region: us-west"} {
		if !strings.Contains(reg, want) {
			t.Errorf("registry missing %q:\n%s", want, reg)
		}
	}

	// Remove-instance CRs retire folder + registry entry.
	cr2, _ := svc.Store.Draft("carol", "main")
	cr2.UpsertItem(change.Item{Instance: "staging", Action: change.ActionRemoveInstance})
	got2, err := svc.Submit(ctx, cr2.ID, "Retire staging", "", "carol", "", "")
	if err != nil {
		t.Fatal(err)
	}
	tree := sh(t, originDir, "git", "ls-tree", "-r", "--name-only", got2.Branch)
	if strings.Contains(tree, "instances/staging/") {
		t.Errorf("retired instance folder still on branch:\n%s", tree)
	}
	reg2 := sh(t, originDir, "git", "show", got2.Branch+":.configer/instances.yaml")
	if strings.Contains(reg2, "name: staging") {
		t.Errorf("retired instance still registered:\n%s", reg2)
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
