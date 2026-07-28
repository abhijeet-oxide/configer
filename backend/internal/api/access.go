package api

// Where a user's capability on ONE application comes from.
//
// A role is a property of (person, application), never of a person. The same
// engineer is an admin on one repository and a reader on another, and Configer
// must say so rather than stamping one label across the whole product.
//
// Sources are consulted in order and the first that answers wins:
//
//  1. deployment administrator  - CONFIGER_ADMINS, approves everywhere
//  2. explicit Configer grant   - a row in app_members, set by an admin; the
//     deliberate override, so a decision made here is never silently undone by
//     a change on the Git side
//  3. the user's own Git access - when the application is a GitHub repository
//     AND the request carries that user's OWN credential, their permission on
//     the repository IS their permission here. Nothing to configure twice, and
//     it cannot drift from the thing it mirrors.
//  4. the deployment default    - everything else
//
// (3) only applies to a per-user credential. With one shared server token every
// caller would otherwise inherit whatever that token can do, which is not the
// user's access at all - it is the service's. In that mode Configer has no way
// to tell people apart yet, so the default applies to everyone; the ordered
// chain below is where a real user-management or external-provider layer slots
// in when it exists, as one more Source before the default.

import (
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/gitengine"
	"github.com/abhijeet-oxide/configer/backend/internal/store"
)

// Grant is a resolved role plus where it came from, so the UI can answer "why
// am I only a viewer here?" instead of just asserting it.
type Grant struct {
	Role store.Role `json:"role"`
	// Source is a stable machine key: "admin", "configer", "git", "default".
	Source string `json:"source"`
	// Detail is the same thing in the user's words.
	Detail string `json:"detail,omitempty"`
}

// gitPermissionRole maps a GitHub repository permission set onto Configer's
// three capabilities. GitHub's ladder is pull < triage < push < maintain <
// admin; Configer's is viewer < editor < approver. Read means read, write means
// write, and the two levels that administer the repository are the two that may
// publish here.
func gitPermissionRole(p gitPermissions) (store.Role, bool) {
	switch {
	case p.Admin, p.Maintain:
		return store.RoleApprover, true
	case p.Push:
		return store.RoleEditor, true
	case p.Triage, p.Pull:
		return store.RoleViewer, true
	}
	return "", false
}

// gitPermissions is the permission block GitHub returns on a repository for the
// authenticated user.
type gitPermissions struct {
	Admin    bool `json:"admin"`
	Maintain bool `json:"maintain"`
	Push     bool `json:"push"`
	Triage   bool `json:"triage"`
	Pull     bool `json:"pull"`
}

// gitRoleTTL is how long a mirrored Git role is trusted. Authorization runs on
// every repo-scoped request, so this cannot be a call to GitHub each time; a
// few minutes keeps a permission change on the Git side arriving promptly
// without turning every read into a round trip.
const gitRoleTTL = 5 * time.Minute

type gitRoleEntry struct {
	role store.Role
	ok   bool
	at   time.Time
}

// gitRoleCache memoizes (login, application) -> role for gitRoleTTL.
type gitRoleCache struct {
	mu sync.Mutex
	m  map[string]gitRoleEntry
}

func newGitRoleCache() *gitRoleCache { return &gitRoleCache{m: map[string]gitRoleEntry{}} }

func (c *gitRoleCache) get(key string) (store.Role, bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[key]
	if !ok || time.Since(e.at) > gitRoleTTL {
		return "", false, false
	}
	return e.role, e.ok, true
}

func (c *gitRoleCache) put(key string, role store.Role, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) > 2048 { // bounded; entries expire anyway
		c.m = map[string]gitRoleEntry{}
	}
	c.m[key] = gitRoleEntry{role: role, ok: ok, at: time.Now()}
}

// Forget drops a user's cached Git roles, so a permission change that the user
// has just made on GitHub can be picked up without waiting out the TTL.
func (c *gitRoleCache) Forget(login string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.m {
		if strings.HasPrefix(k, login+"|") {
			delete(c.m, k)
		}
	}
}

// gitRole reads the caller's own permission on the application's repository.
// It answers only when all of it is true: the application came from GitHub, and
// the request carries this user's OWN OAuth token. A shared server token is
// deliberately not used - it describes the service's access, not the person's.
func (h *Hub) gitRole(r *http.Request, repoID string, u store.User) (store.Role, bool) {
	if u.Login == "" || h.auth == nil {
		return "", false
	}
	token := h.auth.GitHubToken(u.Login)
	if token == "" {
		return "", false
	}
	full, ok := h.repoFullName(repoID)
	if !ok {
		return "", false
	}
	key := u.Login + "|" + repoID
	if role, found, cached := h.gitRoles.get(key); cached {
		return role, found
	}
	var repo struct {
		Permissions gitPermissions `json:"permissions"`
	}
	if err := h.ghGet(r, token, "/repos/"+full, &repo); err != nil {
		// Unreachable, or the user genuinely cannot see the repository. Either
		// way this source has no answer; the chain moves on. Cached briefly so
		// a broken token does not mean a GitHub call per request.
		h.gitRoles.put(key, "", false)
		return "", false
	}
	role, found := gitPermissionRole(repo.Permissions)
	h.gitRoles.put(key, role, found)
	return role, found
}

// repoFullName returns the "owner/name" of an application backed by GitHub, or
// false when it is not (another host, or a folder with no remote).
//
// The workspace entry's origin answers for a repository connected by URL. A
// folder opened from disk records its PATH there, so the second lookup asks the
// working tree for its actual remote: a local clone of a GitHub repository is
// still that repository, and the person's permission on it is still the right
// answer.
func (h *Hub) repoFullName(repoID string) (string, bool) {
	for _, e := range h.registry.List() {
		if e.ID != repoID {
			continue
		}
		if full, ok := gitengine.GitHubFullName(e.Origin); ok {
			return full, true
		}
		if s, _ := h.server(e.ID); s != nil {
			return gitengine.GitHubFullName(s.Backend.Origin())
		}
		return "", false
	}
	return "", false
}

// grantFor resolves a user's capability on one application, in the documented
// order, and reports where the answer came from.
func (h *Hub) grantFor(r *http.Request, repoID string, u store.User) Grant {
	if u.Admin {
		return Grant{Role: store.RoleApprover, Source: "admin",
			Detail: "you are an administrator of this Configer deployment"}
	}
	if h.platform != nil {
		role, err := h.platform.MemberRole(r.Context(), repoID, u.Login)
		if err == nil {
			return Grant{Role: role, Source: "configer",
				Detail: "an administrator granted you this access in Configer"}
		} else if !errors.Is(err, store.ErrNotFound) {
			// Database trouble: fail safe, never up.
			return Grant{Role: store.RoleViewer, Source: "default",
				Detail: "your access could not be read just now, so it is limited to viewing"}
		}
	}
	if role, ok := h.gitRole(r, repoID, u); ok {
		return Grant{Role: role, Source: "git",
			Detail: "this mirrors your permission on the repository in GitHub"}
	}
	return Grant{Role: defaultRole(), Source: "default",
		Detail: "this deployment's default access for everyone signed in"}
}

// grantWorkers bounds how many applications are resolved at once. The
// portfolio asks for every application's grant in one request, and a cold cache
// makes each of those a call to GitHub; done one after another a large
// workspace would stall the first page the user sees.
const grantWorkers = 8

// grantsFor resolves one user's capability on many applications at once.
func (h *Hub) grantsFor(r *http.Request, ids []string, u store.User) map[string]Grant {
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
			g := h.grantFor(r, id, u)
			mu.Lock()
			out[id] = g
			mu.Unlock()
		}(id)
	}
	wg.Wait()
	return out
}

// effectiveRole is grantFor's answer alone, for the authorization path.
func (h *Hub) effectiveRole(r *http.Request, repoID string, u store.User) store.Role {
	return h.grantFor(r, repoID, u).Role
}
