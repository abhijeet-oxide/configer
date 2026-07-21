package search

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// DocsFor builds the index documents for one application from its loaded project
// and its change requests. Secrets are excluded. The app name rides in each
// doc's subtitle and keywords so a cross-application search reads clearly and
// can be narrowed by typing the app name.
func DocsFor(appID, appName string, p *project.Project, crs []*change.ChangeRequest) []Doc {
	docs := make([]Doc, 0, len(p.Catalog.Parameters)+len(p.Registry.Instances)+len(crs))

	for _, param := range p.Catalog.Parameters {
		if param.Secret {
			continue
		}
		docs = append(docs, Doc{
			Type:     TypeParameter,
			AppID:    appID,
			DocID:    param.ID,
			Title:    param.Name,
			Subtitle: subtitle(param.Category, appName),
			Keywords: keywords(param.Name, param.DisplayName, param.Description, param.Category, param.ID, string(param.Type), appName),
			Target:   navTarget(Target{Kind: "navigate", App: appID, View: "config", Param: param.ID}),
		})
	}

	for _, inst := range p.Registry.Instances {
		docs = append(docs, Doc{
			Type:     TypeInstance,
			AppID:    appID,
			DocID:    inst.Name,
			Title:    inst.Name,
			Subtitle: subtitle(inst.Environment, appName),
			Keywords: keywords(inst.Name, inst.Environment, inst.Region, inst.Zone, inst.Site, inst.SoftwareVersion, appName),
			Target:   navTarget(Target{Kind: "navigate", App: appID, View: "instances", Inst: inst.Name}),
		})
	}

	for _, cr := range crs {
		view := "changes"
		if cr.State == change.StateUnderReview {
			view = "approvals"
		}
		docs = append(docs, Doc{
			Type:     TypeChange,
			AppID:    appID,
			DocID:    strconv.Itoa(cr.ID),
			Title:    fmt.Sprintf("#%d %s", cr.ID, cr.Title),
			Subtitle: subtitle(stateLabel(cr.State), appName),
			Keywords: keywords(cr.Title, cr.Reference, cr.Category, cr.Author, string(cr.State), appName),
			Badges:   []Badge{{Text: stateLabel(cr.State)}},
			Target:   navTarget(Target{Kind: "navigate", App: appID, View: view}),
		})
	}

	return docs
}

func navTarget(t Target) json.RawMessage {
	b, _ := json.Marshal(t)
	return b
}

// subtitle joins the non-empty parts with a middle dot (the app name last).
func subtitle(parts ...string) string {
	kept := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, " · ")
}

// keywords lowercases and space-joins the non-empty fields into one haystack.
func keywords(parts ...string) string {
	kept := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return strings.ToLower(strings.Join(kept, " "))
}

func stateLabel(s change.State) string {
	switch s {
	case change.StateDraft:
		return "Draft"
	case change.StateUnderReview:
		return "Under review"
	case change.StateApproved:
		return "Approved"
	case change.StatePublished:
		return "Published"
	case change.StateRejected:
		return "Rejected"
	default:
		return string(s)
	}
}
