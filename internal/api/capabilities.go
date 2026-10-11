package api

// What this deployment can actually do.
//
// The UI offers workflows; some of them only exist under conditions the browser
// cannot see. "Local folder" is the clearest case: it browses the SERVER's
// filesystem, which is the user's own filesystem when Configer runs on their
// machine, and somebody else's container when it is hosted. Offering it in the
// second case invites the user to go looking for their own Documents folder on
// a machine they have never seen.
//
// So the server answers the question directly, once, and the UI offers only
// what will work.

import (
	"net"
	"net/http"
	"os"
	"strings"
)

// Capabilities describes the workflows this deployment supports.
type Capabilities struct {
	// LocalFolders: the "Local folder" source is meaningful here, i.e. the
	// browser and the server share a filesystem.
	LocalFolders bool `json:"localFolders"`
	// GitHubSignIn: GitHub OAuth is configured, so a user can sign in and
	// browse their own repositories.
	GitHubSignIn bool `json:"githubSignIn"`
	// GitHubBrowse: a GitHub credential is available right now (the signed-in
	// user's, or a deployment-wide token), so the repository picker can list.
	GitHubBrowse bool `json:"githubBrowse"`
	// ManualGitURL: connecting a repository by its Git URL. Always available -
	// it is the fallback that needs no integration at all.
	ManualGitURL bool `json:"manualGitUrl"`
	// Hosted: this deployment is served to browsers elsewhere (as opposed to
	// running on the user's own machine). Display only.
	Hosted bool `json:"hosted"`
}

// capabilities reports what this deployment supports.
//
// @Summary     Deployment capabilities
// @Description Which New Application sources and integrations this deployment supports (local folder browsing, GitHub sign-in, GitHub browsing, manual Git URL). The UI offers only what will work here, instead of presenting options that cannot succeed.
// @Tags        Workspace
// @Produce     json
// @Success     200 {object} Capabilities
// @Router      /api/capabilities [get]
func (h *Hub) capabilities(w http.ResponseWriter, r *http.Request) {
	token, _, _ := h.githubCred(r)
	hosted := !servesLocalBrowser(r, h.Environment)
	writeJSON(w, http.StatusOK, Capabilities{
		LocalFolders: localFoldersEnabled(r, h.Environment),
		GitHubSignIn: h.auth.Enabled(),
		GitHubBrowse: token != "",
		ManualGitURL: true,
		Hosted:       hosted,
	})
}

// localFoldersEnabled decides whether to offer the local-folder source.
// CONFIGER_LOCAL_FOLDERS forces it either way for the cases no heuristic can
// know (a kiosk, a workstation VM, a demo); otherwise it follows whether this
// request plausibly came from a browser on the same machine.
func localFoldersEnabled(r *http.Request, environment string) bool {
	if v := strings.TrimSpace(os.Getenv("CONFIGER_LOCAL_FOLDERS")); v != "" {
		return truthyEnv(v)
	}
	return servesLocalBrowser(r, environment)
}

// servesLocalBrowser reports whether the browser making this request is running
// on the same machine as the server. Three signals, each of which alone is
// enough to say "no":
//
//   - A production deployment is hosted by definition.
//   - A forwarding header means a proxy sits in front, so the loopback address
//     we observe is the proxy's, not the user's.
//   - Otherwise the peer address settles it: loopback means same machine.
func servesLocalBrowser(r *http.Request, environment string) bool {
	if strings.EqualFold(strings.TrimSpace(environment), "production") {
		return false
	}
	if r.Header.Get("X-Forwarded-For") != "" || r.Header.Get("X-Real-IP") != "" ||
		r.Header.Get("Forwarded") != "" {
		return false
	}
	return isLoopbackAddr(r.RemoteAddr)
}

func isLoopbackAddr(remoteAddr string) bool {
	host := remoteAddr
	if h, _, err := net.SplitHostPort(remoteAddr); err == nil {
		host = h
	}
	if host == "" {
		return false
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

func truthyEnv(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
