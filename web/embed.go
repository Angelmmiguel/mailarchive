// Package web embeds the compiled SvelteKit application and serves it with the
// single-page-app fallback the router needs.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:build
var embedded embed.FS

// build is the embedded build directory. fs.Sub cannot fail for a directory
// that is embedded above.
var build = func() fs.FS {
	sub, err := fs.Sub(embedded, "build")
	if err != nil {
		panic(err)
	}
	return sub
}()

const indexFile = "index.html"

// Handler serves the embedded web app: real files as they are, every other
// path as index.html so client-side routing works on a cold load.
//
// If the app has not been built into web/build, it answers 503 instead of
// pretending the routes exist.
func Handler() http.Handler { return handler(build) }

// handler is Handler over an arbitrary file system, so the routing and caching
// rules can be tested without a real build.
func handler(fsys fs.FS) http.Handler {
	_, err := fs.Stat(fsys, indexFile)
	built := err == nil

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The API is routed before this handler; anything left under /api is a
		// missing endpoint, never an SPA route.
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		if !built {
			http.Error(w, "UI not built", http.StatusServiceUnavailable)
			return
		}

		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name == "" || !fs.ValidPath(name) {
			serveIndex(w, r, fsys)
			return
		}
		info, err := fs.Stat(fsys, name)
		if err != nil || info.IsDir() {
			serveIndex(w, r, fsys)
			return
		}
		// Hashed asset paths never change contents, so they can be cached
		// forever; anything else is revalidated.
		if strings.HasPrefix(name, "_app/immutable/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		http.ServeFileFS(w, r, fsys, name)
	})
}

func serveIndex(w http.ResponseWriter, r *http.Request, fsys fs.FS) {
	// The shell embeds the app's entry points and must never be served stale.
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFileFS(w, r, fsys, indexFile)
}
