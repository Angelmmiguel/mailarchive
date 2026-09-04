package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

// builtFS stands in for a compiled SvelteKit build.
var builtFS = fstest.MapFS{
	"index.html":              {Data: []byte("<!doctype html>shell")},
	"favicon.png":             {Data: []byte("icon")},
	"_app/immutable/x.js":     {Data: []byte("export const x = 1")},
	"assets/nested/style.css": {Data: []byte("body{}")},
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func TestHandlerServesFilesAndFallsBackToIndex(t *testing.T) {
	h := handler(builtFS)

	for _, path := range []string{"/", "/messages/1", "/messages/1/attachments"} {
		rec := get(t, h, path)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", path, rec.Code)
		}
		if body := rec.Body.String(); body != "<!doctype html>shell" {
			t.Errorf("GET %s body = %q, want the index", path, body)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("GET %s Cache-Control = %q, want no-store", path, got)
		}
	}

	rec := get(t, h, "/favicon.png")
	if rec.Code != http.StatusOK || rec.Body.String() != "icon" {
		t.Errorf("GET /favicon.png = %d %q, want the real file", rec.Code, rec.Body)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("GET /favicon.png Cache-Control = %q, want no-cache", got)
	}
}

func TestHandlerCachesHashedAssetsForever(t *testing.T) {
	rec := get(t, handler(builtFS), "/_app/immutable/x.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	const want = "public, max-age=31536000, immutable"
	if got := rec.Header().Get("Cache-Control"); got != want {
		t.Errorf("Cache-Control = %q, want %q", got, want)
	}
}

func TestHandlerWithoutAnIndex(t *testing.T) {
	h := handler(fstest.MapFS{"favicon.png": {Data: []byte("icon")}})

	// Without the shell the app cannot run, so even files that do exist are
	// not worth serving.
	for _, path := range []string{"/", "/messages/1", "/favicon.png"} {
		if rec := get(t, h, path); rec.Code != http.StatusServiceUnavailable {
			t.Errorf("GET %s = %d, want 503", path, rec.Code)
		}
	}
	if rec := get(t, h, "/api/unknown"); rec.Code != http.StatusNotFound {
		t.Errorf("GET /api/unknown = %d, want 404", rec.Code)
	}
}

func TestHandlerNeverServesAPIPathsFromTheFS(t *testing.T) {
	rec := get(t, handler(fstest.MapFS{
		"index.html":   {Data: []byte("shell")},
		"api/leak.txt": {Data: []byte("secret")},
	}), "/api/leak.txt")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// The repository ships an empty web/build, so the handler must say so instead
// of pretending the app routes exist. Once the SPA is built, the same handler
// serves it.
func TestHandlerWithoutABuild(t *testing.T) {
	h := Handler()

	for _, path := range []string{"/", "/messages/1", "/_app/immutable/app.js"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("GET %s = %d, want 503", path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "UI not built") {
			t.Errorf("GET %s body = %q", path, rec.Body.String())
		}
	}
}

func TestHandlerNeverServesAPIPaths(t *testing.T) {
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/unknown", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /api/unknown = %d, want 404", rec.Code)
	}
}
