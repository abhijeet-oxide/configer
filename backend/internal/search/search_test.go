package search_test

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
	"github.com/abhijeet-oxide/configer/backend/internal/search"
)

func fixture() (*project.Project, []*change.ChangeRequest) {
	p := &project.Project{
		App: model.Application{Name: "Billing"},
		Catalog: model.Catalog{Parameters: []model.Parameter{
			{ID: "net-admin-port", Name: "network.admin.port", Category: "Networking", Type: "integer"},
			{ID: "api-secret", Name: "api.secret.key", Category: "Security", Type: "string", Secret: true},
		}},
		Registry: model.InstanceRegistry{Instances: []model.Instance{
			{Name: "prod-us-east", Environment: "production"},
		}},
	}
	crs := []*change.ChangeRequest{
		{ID: 12, Title: "Bump admin port", State: change.StateUnderReview, Author: "abhi"},
	}
	return p, crs
}

func TestDocsForExcludesSecrets(t *testing.T) {
	p, crs := fixture()
	docs := search.DocsFor("billing", p.Name(), p, crs)
	// 2 params (1 secret excluded) + 1 instance + 1 change = 3.
	if len(docs) != 3 {
		t.Fatalf("want 3 docs, got %d", len(docs))
	}
	for _, d := range docs {
		if d.DocID == "api-secret" {
			t.Fatalf("secret parameter must not be indexed")
		}
	}
}

func targetOf(t *testing.T, raw json.RawMessage) search.Target {
	t.Helper()
	var tg search.Target
	if err := json.Unmarshal(raw, &tg); err != nil {
		t.Fatalf("bad target json: %v", err)
	}
	return tg
}

func TestMemorySearch(t *testing.T) {
	p, crs := fixture()
	docs := search.DocsFor("billing", p.Name(), p, crs)

	ix, err := search.New(nil, "", 50000) // memory-only tier
	if err != nil {
		t.Fatal(err)
	}
	if err := ix.ReplaceApp("billing", docs); err != nil {
		t.Fatal(err)
	}

	hits, err := ix.Search("port", "global", "", 20)
	if err != nil {
		t.Fatal(err)
	}
	var param *search.Hit
	for i := range hits {
		if hits[i].Type == search.TypeParameter {
			param = &hits[i]
		}
	}
	if param == nil {
		t.Fatalf("expected a parameter hit for %q, got %+v", "port", hits)
	}
	if param.Title != "network.admin.port" {
		t.Fatalf("unexpected title %q", param.Title)
	}
	tg := targetOf(t, param.Target)
	if tg.View != "config" || tg.Param != "net-admin-port" || tg.App != "billing" {
		t.Fatalf("unexpected target %+v", tg)
	}

	// A secret must never surface, even by its name.
	if got, _ := ix.Search("secret", "global", "", 20); len(got) != 0 {
		t.Fatalf("secret leaked into results: %+v", got)
	}

	// An empty query returns nothing (the client fills the empty state).
	if got, _ := ix.Search("", "global", "", 20); len(got) != 0 {
		t.Fatalf("empty query should return no hits, got %d", len(got))
	}
}

func TestFTSOverflowPath(t *testing.T) {
	p, crs := fixture()
	docs := search.DocsFor("billing", p.Name(), p, crs)

	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "search.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()

	// memMax=1 with 3 docs forces the overflow (FTS5) query path.
	ix, err := search.New(db, "sqlite", 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := ix.ReplaceApp("billing", docs); err != nil {
		t.Fatal(err)
	}

	hits, err := ix.Search("network", "global", "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Fatalf("FTS path returned no hits for %q", "network")
	}
	tg := targetOf(t, hits[0].Target)
	if tg.App != "billing" {
		t.Fatalf("unexpected target app %q", tg.App)
	}

	// Restrict to a nonexistent app id: no hits.
	if got, _ := ix.Search("network", "global", "other-app", 20); len(got) != 0 {
		t.Fatalf("appID filter failed, got %+v", got)
	}

	// RemoveApp clears both tiers.
	if err := ix.RemoveApp("billing"); err != nil {
		t.Fatal(err)
	}
	if got, _ := ix.Search("network", "global", "", 20); len(got) != 0 {
		t.Fatalf("RemoveApp left results: %+v", got)
	}
}
