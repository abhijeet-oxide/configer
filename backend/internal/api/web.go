package api

// Serving the user interface.
//
// Configer's UI is a single-page app: every screen has a real address
// (/applications, /application/<id>/editor, …) and the browser asks the SERVER
// for that address on a reload, a bookmark, or the redirect that ends a login.
// Unless the server answers those with the app's index page, the user lands on
// a "not found" instead of the page they were sent to - which is exactly what a
// post-login redirect looks like when it goes wrong.
//
// So the backend serves the built UI whenever it can find it:
//
//	CONFIGER_WEB_DIR=/srv/configer/web   explicit (a container image, a package)
//	./web                                next to the binary
//	../frontend/dist                     a local build, for `go run`
//
// Deployments that serve the UI from their own web server (the bundled
// docker-compose stack uses nginx) simply have no such directory, and the
// backend then says where the app lives instead of 404-ing blankly.

import (
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// webDir resolves the directory holding the built UI, or "" when this
// deployment does not bundle one.
func webDir() string {
	if d := strings.TrimSpace(os.Getenv("CONFIGER_WEB_DIR")); d != "" {
		if isDir(d) {
			return d
		}
		slog.Warn("CONFIGER_WEB_DIR does not point at a directory; the UI will not be served by this process",
			slog.String("path", d))
		return ""
	}
	for _, c := range []string{"./web", "../frontend/dist"} {
		if isDir(c) && isFile(filepath.Join(c, "index.html")) {
			return c
		}
	}
	return ""
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// webHandler serves the single-page app: real files when they exist, and the
// app's index page for every other address, so a deep link or a post-login
// redirect opens the screen it names instead of a "not found".
func webHandler(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	index := filepath.Join(dir, "index.html")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		clean := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if clean != "." && !strings.HasPrefix(clean, "..") && isFile(filepath.Join(dir, clean)) {
			// Hashed assets are immutable; the index never is, or a browser
			// pins a stale bundle after a deploy.
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			files.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, index)
	})
}

// noWebHandler answers when this process serves only the API. A browser that
// arrives here has followed an address that belongs to the app (often the end
// of a login), so it is redirected to the app when its address is known, and
// told plainly where to look when it is not.
func noWebHandler(appURL string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if appURL != "" {
			target := strings.TrimSuffix(appURL, "/") + r.URL.RequestURI()
			http.Redirect(w, r, target, http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`<!doctype html><html><head><meta charset="utf-8">` +
			`<title>Configer</title></head><body style="font:14px/1.6 system-ui;margin:12vh auto;max-width:34em;padding:0 1.5em">` +
			`<h1 style="font-size:1.3em">Configer service</h1>` +
			`<p>This address serves the Configer API. The Configer app is served separately in this deployment - ` +
			`open it at its own address.</p>` +
			`<p><a href="/api/docs">API documentation</a></p>` +
			`</body></html>`))
	})
}
