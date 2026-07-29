package changeset

import (
	"context"
	"errors"
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

// sh runs a command in dir. Raw git calls carry their own identity: production
// git always goes through gitengine, which supplies one, so a test that shells
// out directly must too - otherwise the suite only passes on a machine that
// happens to have a global user.name (a CI runner has none).
func sh(t *testing.T, dir string, name string, args ...string) string {
	t.Helper()
	if name == "git" {
		args = append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)
	}
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

// stage puts pending items into a draft the way the api layer does: through
// the store's Update. A change request the store hands back is a COPY, so
// editing one in place stages nothing - which is the whole point of the
// contract, and is why this helper exists rather than a line of test setup.
func stage(t *testing.T, svc *Service, id int, items ...change.Item) {
	t.Helper()
	if _, err := svc.Store.Update(id, func(cr *change.ChangeRequest) error {
		for _, it := range items {
			cr.UpsertItem(it)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// The session user is the git AUTHOR of a submitted change; the machine
// identity stays the committer and is credited via Co-authored-by.
func TestSubmitAuthorAttribution(t *testing.T) {
	_, originDir, svc := fixture(t)
	svc.Bot = repobackend.Author{Name: "Configer Bot", Email: "bot@configer.local"}
	ctx := context.Background()

	cr, err := svc.Store.Draft("alice", "main")
	if err != nil {
		t.Fatal(err)
	}
	stage(t, svc, cr.ID, change.Item{ParamID: "p1", Instance: "staging", Old: 8080, New: 9000, UpdatedAt: time.Now()})

	ident := repobackend.Author{Name: "Alice Doe", Email: "alice@example.com"}
	got, err := svc.Submit(ctx, SubmitRequest{ID: cr.ID, Title: "Author attribution", Author: "alice", Ident: ident})
	if err != nil {
		t.Fatal(err)
	}

	an := sh(t, originDir, "git", "log", "-1", "--format=%an <%ae>", got.Branch)
	if strings.TrimSpace(an) != "Alice Doe <alice@example.com>" {
		t.Errorf("author = %q, want the session user", an)
	}
	cn := sh(t, originDir, "git", "log", "-1", "--format=%cn", got.Branch)
	if strings.TrimSpace(cn) != "Configer Bot" {
		t.Errorf("committer = %q, want the machine identity", cn)
	}
	msg := sh(t, originDir, "git", "log", "-1", "--format=%B", got.Branch)
	if !strings.Contains(msg, "Co-authored-by: Configer Bot <bot@configer.local>") {
		t.Errorf("commit message missing bot co-author credit:\n%s", msg)
	}
}

func TestSubmitAndMergePipeline(t *testing.T) {
	workDir, originDir, svc := fixture(t)
	ctx := context.Background()

	// Stage a draft with one per-instance edit and one global edit.
	cr, err := svc.Store.Draft("alice@example.com", "main")
	if err != nil {
		t.Fatal(err)
	}
	stage(t, svc, cr.ID,
		change.Item{ParamID: "p1", Instance: "staging", Old: 8080, New: 9443, UpdatedAt: time.Now()},
		change.Item{ParamID: "p2", Scope: "global", Old: "example.com", New: "corp.example.com", UpdatedAt: time.Now()},
	)

	// Submit: branch + write-back + commit + push.
	got, err := svc.Submit(ctx, SubmitRequest{ID: cr.ID, Title: "Bump staging port", Description: "Rollout of the new listener", Author: "alice@example.com", Reference: "JIRA-42", Category: "feature"})
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
	stage(t, svc, cr.ID, change.Item{ParamID: "p1", Instance: "staging", Action: change.ActionReset, Old: 8080, UpdatedAt: time.Now()})

	got, err := svc.Submit(ctx, SubmitRequest{ID: cr.ID, Title: "Drop staging port override", Author: "bob"})
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
// instance land inside the scaffolded folder - one reviewable commit.
func TestSubmitAddInstance(t *testing.T) {
	_, originDir, svc := fixture(t)
	ctx := context.Background()

	cr, _ := svc.Store.Draft("carol", "main")
	stage(t, svc, cr.ID,
		change.Item{
			Instance: "dr",
			Action:   change.ActionAddInstance,
			Old:      "prod", // clone source
			New:      map[string]any{"environment": "production", "region": "us-west"},
		},
	)
	// A value edit for the new instance rides the same CR.
	stage(t, svc, cr.ID, change.Item{ParamID: "p1", Instance: "dr", New: 7443, UpdatedAt: time.Now()})

	got, err := svc.Submit(ctx, SubmitRequest{ID: cr.ID, Title: "Add DR instance", Author: "carol"})
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
	stage(t, svc, cr2.ID, change.Item{Instance: "staging", Action: change.ActionRemoveInstance})
	got2, err := svc.Submit(ctx, SubmitRequest{ID: cr2.ID, Title: "Retire staging", Author: "carol"})
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

// Preview reports the exact bytes a submit would write, without creating a
// branch or committing: a per-instance value edit, a global edit, and a
// structural add-instance summarized separately.
func TestPreviewShowsByteLevelDiff(t *testing.T) {
	_, _, svc := fixture(t)
	ctx := context.Background()

	cr, _ := svc.Store.Draft("alice", "main")
	stage(t, svc, cr.ID,
		change.Item{ParamID: "p1", Instance: "staging", Old: 8080, New: 9443, UpdatedAt: time.Now()},
		change.Item{ParamID: "p2", Scope: "global", Old: "example.com", New: "corp.example.com"},
		change.Item{Instance: "dr", Action: change.ActionAddInstance, Old: "prod", New: map[string]any{"environment": "production"}},
	)

	res, err := svc.Preview(ctx, cr.ID)
	if err != nil {
		t.Fatal(err)
	}

	byFile := map[string]FilePreview{}
	for _, f := range res.Files {
		byFile[f.File] = f
	}

	sv, ok := byFile["instances/staging/values.yaml"]
	if !ok {
		t.Fatalf("no preview for staging values: %+v", res.Files)
	}
	if sv.Status != "modified" {
		t.Errorf("status = %q, want modified", sv.Status)
	}
	if !strings.Contains(sv.Before, "8080") || !strings.Contains(sv.After, "9443") {
		t.Errorf("before/after wrong:\n--before--\n%s\n--after--\n%s", sv.Before, sv.After)
	}
	if sv.Additions != 1 || sv.Deletions != 1 {
		t.Errorf("line delta = +%d/-%d, want +1/-1", sv.Additions, sv.Deletions)
	}
	// The preview is the real surgical write: comment + unmanaged key survive.
	for _, keep := range []string{"# Staging values.", "unmanaged: keep-me", "name: demo"} {
		if !strings.Contains(sv.After, keep) {
			t.Errorf("preview lost %q:\n%s", keep, sv.After)
		}
	}
	if _, ok := byFile["shared/platform.yaml"]; !ok {
		t.Errorf("no preview for the global (shared) edit: %+v", res.Files)
	}

	// Structural change is summarized, not byte-diffed.
	if len(res.Structural) != 1 || !strings.Contains(res.Structural[0], "add instance dr") {
		t.Errorf("structural summary = %v, want [add instance dr (clone of prod)]", res.Structural)
	}

	// Preview must not commit or branch: the draft stays the current draft.
	if d := svc.Store.CurrentDraft("alice"); d == nil || d.ID != cr.ID {
		t.Errorf("preview disturbed the draft state")
	}
}

func TestRejectDraftAndSubmitted(t *testing.T) {
	_, _, svc := fixture(t)
	ctx := context.Background()

	// Draft rejection deletes it.
	cr, _ := svc.Store.Draft("bob", "main")
	stage(t, svc, cr.ID, change.Item{ParamID: "p1", Instance: "staging", Old: 8080, New: 9000})
	if _, err := svc.Reject(ctx, cr.ID, "", ""); err != nil {
		t.Fatal(err)
	}
	if svc.Store.CurrentDraft("bob") != nil {
		t.Error("draft should be deleted after reject")
	}

	// Submitted CR rejection keeps the record with state rejected.
	cr2, _ := svc.Store.Draft("bob", "main")
	stage(t, svc, cr2.ID, change.Item{ParamID: "p1", Instance: "staging", Old: 8080, New: 9001})
	sub, err := svc.Submit(ctx, SubmitRequest{ID: cr2.ID, Title: "t", Author: "bob"})
	if err != nil {
		t.Fatal(err)
	}
	rej, err := svc.Reject(ctx, sub.ID, "bob", "not now")
	if err != nil {
		t.Fatal(err)
	}
	if rej.State != change.StateRejected {
		t.Fatalf("state = %s, want rejected", rej.State)
	}
}

// Under a shared-deployment policy the author cannot approve their own change
// (separation of duties), and nothing publishes without a recorded approval.
func TestGovernancePolicy(t *testing.T) {
	_, _, svc := fixture(t)
	svc.Policy = Policy{RequireApproval: true, RequireSeparateApprover: true, MinApprovals: 1}
	ctx := context.Background()

	cr, _ := svc.Store.Draft("alice@example.com", "main")
	stage(t, svc, cr.ID, change.Item{ParamID: "p1", Instance: "staging", Old: 8080, New: 9000, UpdatedAt: time.Now()})
	sub, err := svc.Submit(ctx, SubmitRequest{ID: cr.ID, Title: "Bump port", Author: "alice@example.com"})
	if err != nil {
		t.Fatal(err)
	}

	// Publishing an unapproved change is refused.
	if _, err := svc.Merge(ctx, sub.ID); err == nil {
		t.Error("expected merge of an unapproved change to be refused")
	}
	// The author cannot approve their own change.
	if _, err := svc.Approve(ctx, sub.ID, "alice@example.com"); err == nil {
		t.Error("expected self-approval to be refused (separation of duties)")
	}
	// A separate approver signs off, then publish succeeds.
	appr, err := svc.Approve(ctx, sub.ID, "bob@example.com")
	if err != nil {
		t.Fatalf("separate approver rejected: %v", err)
	}
	if appr.State != change.StateApproved {
		t.Fatalf("state = %s, want approved", appr.State)
	}
	if !appr.HasApprovalFrom("bob@example.com") {
		t.Error("approval not recorded on the change request")
	}
	if _, err := svc.Merge(ctx, sub.ID); err != nil {
		t.Fatalf("merge of an approved change failed: %v", err)
	}
}

// Two distinct approvals are required before the change is considered approved.
func TestMinApprovals(t *testing.T) {
	_, _, svc := fixture(t)
	svc.Policy = Policy{RequireApproval: true, MinApprovals: 2}
	ctx := context.Background()

	cr, _ := svc.Store.Draft("alice@example.com", "main")
	stage(t, svc, cr.ID, change.Item{ParamID: "p1", Instance: "staging", Old: 8080, New: 9000, UpdatedAt: time.Now()})
	sub, _ := svc.Submit(ctx, SubmitRequest{ID: cr.ID, Title: "Bump port", Author: "alice@example.com"})

	first, err := svc.Approve(ctx, sub.ID, "bob@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if first.State != change.StateUnderReview {
		t.Fatalf("after one of two approvals state = %s, want still under_review", first.State)
	}
	// The same approver cannot supply the second approval.
	if _, err := svc.Approve(ctx, sub.ID, "bob@example.com"); err == nil {
		t.Error("expected a duplicate approval to be refused")
	}
	second, err := svc.Approve(ctx, sub.ID, "carol@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if second.State != change.StateApproved {
		t.Fatalf("after two approvals state = %s, want approved", second.State)
	}
}

// A value changed on the base branch after an edit was staged must not be
// silently clobbered: submit refuses with a conflict so the drift surfaces.
func TestSubmitDetectsStaleValue(t *testing.T) {
	workDir, _, svc := fixture(t)
	ctx := context.Background()

	cr, _ := svc.Store.Draft("alice", "main")
	stage(t, svc, cr.ID, change.Item{ParamID: "p1", Instance: "staging", Old: 8080, New: 9443, UpdatedAt: time.Now()})

	// Someone else changes the same value directly on main after staging.
	writeFile(t, filepath.Join(workDir, "instances", "staging", "values.yaml"),
		"# Staging values. Hand-maintained comment.\napp:\n  port: 7000 # the listener\n  name: demo\nunmanaged: keep-me\n")
	sh(t, workDir, "git", "commit", "-am", "ops changed the port directly")

	_, err := svc.Submit(ctx, SubmitRequest{ID: cr.ID, Title: "Bump staging port", Author: "alice"})
	if err == nil {
		t.Fatal("expected a conflict submitting against a value that drifted on Git")
	}
	if !strings.Contains(err.Error(), "changed it on Git") {
		t.Errorf("error should explain the drift, got: %v", err)
	}
}

func TestSubmitValidation(t *testing.T) {
	_, _, svc := fixture(t)
	ctx := context.Background()
	// Empty draft cannot be submitted.
	cr, _ := svc.Store.Draft("bob", "main")
	if _, err := svc.Submit(ctx, SubmitRequest{ID: cr.ID, Title: "t", Author: "bob"}); err == nil {
		t.Error("expected error submitting empty draft")
	}
}

// Branch names read the way the person named them. The disambiguating suffix
// exists, but only when the name is genuinely taken - an earlier version put
// the change id on every branch, which made "feature/bump-prod-memory-cr-7" the
// normal case and asked every reader to know what cr-7 was.
func TestBranchBaseIsReadable(t *testing.T) {
	if got := branchBase("Increase prod memory limit", "alice"); got != "feature/alice/increase-prod-memory-limit" {
		t.Fatalf("got %q", got)
	}
	// No real identity (the single-user tool): the title alone, no noise.
	if got := branchBase("Increase prod memory limit", ""); got != "feature/increase-prod-memory-limit" {
		t.Fatalf("got %q", got)
	}
	// A login that is not ref-safe is slugified like the title is.
	if got := branchBase("Bump ports", "Alice O'Brien"); got != "feature/alice-o-brien/bump-ports" {
		t.Fatalf("got %q", got)
	}
	// An unnamed draft still reads as unnamed rather than as an empty ref.
	for _, title := range []string{"", "Draft changes", "unnamed"} {
		if got := branchBase(title, "bob"); got != "feature/bob/unnamed" {
			t.Fatalf("title %q gave %q", title, got)
		}
	}
	// A pasted paragraph is capped to something a human can read.
	long := branchBase(strings.Repeat("very long title ", 20), "bob")
	if len(long) > len("feature/bob/")+maxSlug {
		t.Fatalf("long title was not capped: %q", long)
	}
}

// The suffix appears only when the branch is really taken, and then it is the
// smallest thing that frees the name.
func TestBranchForDisambiguatesOnlyOnConflict(t *testing.T) {
	workDir, _, svc := fixture(t)
	ctx := context.Background()
	cr := &change.ChangeRequest{ID: 7, Title: "Bump prod memory"}

	if got := svc.branchFor(ctx, cr, "alice"); got != "feature/alice/bump-prod-memory" {
		t.Fatalf("a free name was decorated anyway: %q", got)
	}

	// Take the name for real, and the next one steps around it.
	sh(t, workDir, "git", "branch", "feature/alice/bump-prod-memory")
	if got := svc.branchFor(ctx, cr, "alice"); got != "feature/alice/bump-prod-memory-2" {
		t.Fatalf("a taken name was not disambiguated: %q", got)
	}
	sh(t, workDir, "git", "branch", "feature/alice/bump-prod-memory-2")
	if got := svc.branchFor(ctx, cr, "alice"); got != "feature/alice/bump-prod-memory-3" {
		t.Fatalf("second collision: %q", got)
	}

	// A different person is not blocked by a colleague's branch at all, which
	// is the whole reason the owner segment is there.
	if got := svc.branchFor(ctx, cr, "bob"); got != "feature/bob/bump-prod-memory" {
		t.Fatalf("bob was blocked by alice's branch: %q", got)
	}
}

// Two changes IN PLAY under one name is a review problem: approvers see the
// same words twice. A finished change with that name is history, and reusing it
// is allowed.
func TestNameConflictOnlyBlocksOpenChanges(t *testing.T) {
	_, _, svc := fixture(t)

	cr, err := svc.Store.Draft("alice", "main")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Store.Update(cr.ID, func(c *change.ChangeRequest) error {
		c.Title = "Bump prod memory"
		c.State = change.StateUnderReview
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	c := svc.FindNameConflict("Bump prod memory", 0)
	if c == nil || !c.Open || c.ID != cr.ID {
		t.Fatalf("an open change with the same name was not reported: %+v", c)
	}
	// Case is not what tells two names apart.
	if got := svc.FindNameConflict("bump PROD memory", 0); got == nil {
		t.Fatal("name matching is case-sensitive; it should not be")
	}
	// The change being named does not conflict with itself.
	if got := svc.FindNameConflict("Bump prod memory", cr.ID); got != nil {
		t.Fatalf("a change conflicted with itself: %+v", got)
	}
	// A different name is free.
	if got := svc.FindNameConflict("Something else", 0); got != nil {
		t.Fatalf("an unused name reported a conflict: %+v", got)
	}

	// Once it is published, the name is reusable - reported, but not refused.
	if _, err := svc.Store.Update(cr.ID, func(c *change.ChangeRequest) error {
		c.State = change.StatePublished
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	c = svc.FindNameConflict("Bump prod memory", 0)
	if c == nil || c.Open {
		t.Fatalf("a published change should be reported as a closed clash: %+v", c)
	}
}

// Submitting under a name another OPEN change already has is refused, with a
// message that says which change and what to do.
func TestSubmitRefusesADuplicateOpenName(t *testing.T) {
	_, _, svc := fixture(t)
	ctx := context.Background()

	first, _ := svc.Store.Draft("alice", "main")
	stage(t, svc, first.ID, change.Item{ParamID: "p1", Instance: "staging", Old: 8080, New: 9000})
	if _, err := svc.Submit(ctx, SubmitRequest{ID: first.ID, Title: "Bump prod memory", Author: "alice"}); err != nil {
		t.Fatal(err)
	}

	second, _ := svc.Store.Draft("bob", "main")
	stage(t, svc, second.ID, change.Item{ParamID: "p1", Instance: "staging", Old: 8080, New: 9001})
	_, err := svc.Submit(ctx, SubmitRequest{ID: second.ID, Title: "Bump prod memory", Author: "bob"})
	if err == nil {
		t.Fatal("a second open change was allowed under the same name")
	}
	if !strings.Contains(err.Error(), "different name") {
		t.Fatalf("the refusal does not say what to do: %v", err)
	}
	// And it is a conflict, so the UI renders it as a state rather than a fault.
	var conflict *ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("expected a conflict error, got %T", err)
	}
}
