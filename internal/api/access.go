package api

// Access: which actions a request needs, and what the platform's policy engine
// says about them.
//
// There is no role logic here. Every request is named as an action on one of
// two Cerbos resources, and the platform's policies (config/access/policies in
// the platform repository) decide. The viewer/editor/approver words the
// interface shows are DERIVED from those answers so a screen can say what a
// person may do; they never decide anything.

import (
	"net/http"
	"strings"
	"sync"

	"github.com/abhijeet-oxide/configer/internal/store"
	"github.com/abhijeet-oxide/softwareGateway/pkg/authz"
)

// The platform's Cerbos vocabulary for ArtiAuto. Renaming one is a policy change
// in the platform repository too.
const (
	kindWorkspace   = "artiauto_workspace"
	kindApplication = "artiauto_application"

	actView       = "view"
	actEdit       = "edit"
	actSubmit     = "submit"
	actApprove    = "approve"
	actPublish    = "publish"
	actReject     = "reject"
	actAdminister = "administer"

	actCreateApplication = "create_application"
	actViewAudit         = "view_audit"
)

// actionPhrase finishes "you do not have permission to ...".
var actionPhrase = map[string]string{
	actView:              "view this application",
	actEdit:              "change this application's configuration",
	actSubmit:            "send changes for review",
	actApprove:           "approve changes",
	actPublish:           "publish changes",
	actReject:            "reject changes",
	actAdminister:        "change how this application is set up",
	actCreateApplication: "add applications",
	actViewAudit:         "read the audit trail",
}

// administered are the application routes that change how the application is
// set up rather than its configuration values.
var administered = map[string]bool{
	"application": true, "init": true, "deinit": true,
}

// actionFor names what a request to one application asks to do. rest is the
// path below /api/repos/{id}, or below /api for the single-application routes.
func actionFor(method, rest string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return actView
	}
	seg := strings.Split(strings.Trim(rest, "/"), "/")
	head := seg[0]
	if head == "changes" && len(seg) >= 3 {
		switch seg[2] {
		case "submit":
			return actSubmit
		case "approve":
			return actApprove
		case "merge":
			return actPublish
		case "reject":
			return actReject
		}
	}
	if head == "sources" && len(seg) <= 2 {
		return actAdminister
	}
	// Discovery and analysis read the repository and stage nothing.
	if head == "discover" || head == "scan" || (head == "import" && len(seg) > 1 && seg[1] == "analyze") {
		return actView
	}
	if administered[head] {
		return actAdminister
	}
	return actEdit
}

// Grant is a person's capability on one application, as the interface shows it.
type Grant struct {
	Role   store.Role `json:"role"`
	Source string     `json:"source"`
	Detail string     `json:"detail,omitempty"`
}

// applicationResource names one application to the policy engine. Its product
// is read from the application's own metadata (`product:` in
// .configer/application.yaml), so a product role in the platform reaches the
// applications that configure that product.
func (h *Hub) applicationResource(repoID string) authz.Resource {
	return authz.Resource{Kind: kindApplication, ID: repoID, Product: h.productOf(repoID)}
}

func workspaceResource() authz.Resource {
	return authz.Resource{Kind: kindWorkspace, ID: "default"}
}

// productOf is the platform product an application configures, or "" when it
// names none (then only organization roles reach it).
func (h *Hub) productOf(repoID string) string {
	s, _ := h.server(repoID)
	if s == nil {
		return ""
	}
	p, err := s.load()
	if err != nil || p == nil {
		return ""
	}
	return strings.TrimSpace(p.App.Metadata["product"])
}

// grantFor derives the role word for one application from the policy engine's
// answers. "none" is a real answer: the person may not see it.
func (h *Hub) grantFor(r *http.Request, repoID string) Grant {
	if !h.auth.Enabled() {
		return Grant{Role: store.RoleApprover, Source: "single-user"}
	}
	got, err := h.auth.Allowed(r.Context(), h.applicationResource(repoID),
		actView, actEdit, actApprove, actPublish)
	if err != nil {
		return Grant{Source: "platform", Detail: "your access could not be checked just now"}
	}
	detail := "from your roles in the platform"
	switch {
	case got[actApprove] || got[actPublish]:
		return Grant{Role: store.RoleApprover, Source: "platform", Detail: detail}
	case got[actEdit]:
		return Grant{Role: store.RoleEditor, Source: "platform", Detail: detail}
	case got[actView]:
		return Grant{Role: store.RoleViewer, Source: "platform", Detail: detail}
	}
	return Grant{Source: "platform", Detail: "you hold no role that reaches this application"}
}

// grantWorkers bounds how many applications are checked at once for the
// portfolio, which asks about every application in one request.
const grantWorkers = 8

// grantsFor resolves the caller's capability on many applications at once.
func (h *Hub) grantsFor(r *http.Request, ids []string) map[string]Grant {
	out := make(map[string]Grant, len(ids))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, grantWorkers)
	for _, id := range ids {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			g := h.grantFor(r, id)
			mu.Lock()
			out[id] = g
			mu.Unlock()
		}(id)
	}
	wg.Wait()
	return out
}
