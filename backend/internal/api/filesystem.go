package api

// Local-folder browsing for the "New application → Local folder" flow.
//
// When Configer runs on the user's own machine (localhost), the server's
// filesystem IS the user's filesystem, so a folder picker can be backed by a
// simple directory listing: the browser navigates the tree and hands back the
// real absolute path, which the workspace stores as a local pointer (the
// application name + where it lives). Only directory NAMES are ever exposed -
// never file contents - and this is no more powerful than the pre-existing
// "connect a local path" input it replaces.

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// folderEntry is one selectable sub-folder in the picker.
type folderEntry struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	IsRepo      bool   `json:"isRepo"`      // already a git working tree
	HasConfiger bool   `json:"hasConfiger"` // already a Configer application
}

func isGitRepo(dir string) bool {
	info, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil && info.IsDir()
}

func hasConfiger(dir string) bool {
	info, err := os.Stat(filepath.Join(dir, ".configer"))
	return err == nil && info.IsDir()
}

// browseFolders lists the sub-folders of a directory on the server so the New
// Application flow can offer a native-feeling folder picker instead of asking
// the user to type an absolute path. With no ?path it starts at the user's
// home directory.
func (h *Hub) browseFolders(w http.ResponseWriter, r *http.Request) {
	// Listing the server's own filesystem is a deployment-admin action. In
	// single-user (localhost) mode auth is disabled and this is a no-op; with
	// OAuth enabled it stops any signed-in user - let alone an anonymous one -
	// from enumerating server directories (e.g. ?path=/etc).
	if !h.requireAdmin(w, r) {
		return
	}
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if path == "" {
		if home, err := os.UserHomeDir(); err == nil {
			path = home
		} else {
			path = string(os.PathSeparator)
		}
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "that path can't be read"})
		return
	}
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "that folder doesn't exist on this machine"})
		return
	}

	entries, err := os.ReadDir(abs)
	if err != nil {
		// A folder we can't read (permissions) isn't fatal - report it so the
		// picker can show the message and let the user step back out.
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "this folder can't be opened (permission denied)"})
		return
	}
	folders := make([]folderEntry, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue // hide dotfolders (.git, .config, …) - noise for picking a project
		}
		full := filepath.Join(abs, name)
		folders = append(folders, folderEntry{
			Name:        name,
			Path:        full,
			IsRepo:      isGitRepo(full),
			HasConfiger: hasConfiger(full),
		})
	}
	sort.Slice(folders, func(i, j int) bool {
		return strings.ToLower(folders[i].Name) < strings.ToLower(folders[j].Name)
	})

	parent := filepath.Dir(abs)
	if parent == abs {
		parent = "" // already at the filesystem root
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path":        abs,
		"name":        filepath.Base(abs),
		"parent":      parent,
		"isRepo":      isGitRepo(abs),
		"hasConfiger": hasConfiger(abs),
		"folders":     folders,
	})
}
