package server_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Angelmmiguel/mailarchive/internal/auth"
	"github.com/Angelmmiguel/mailarchive/internal/server"
	"github.com/Angelmmiguel/mailarchive/internal/store"
)

// blobID builds a syntactically valid blob id out of a seed character.
func blobID(c string) string { return strings.Repeat(c, store.IDLen) }

func authKey(b byte) string {
	key := make([]byte, auth.AuthKeyLen)
	for i := range key {
		key[i] = b
	}
	return base64.StdEncoding.EncodeToString(key)
}

type harness struct {
	t       *testing.T
	url     string
	client  *http.Client
	dataDir string
}

type options struct {
	cfg     server.Config
	limiter *auth.RateLimiter
}

func newHarness(t *testing.T, opts ...func(*options)) *harness {
	t.Helper()

	o := options{
		cfg: server.Config{
			Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
			UI: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				_, _ = io.WriteString(w, "<!doctype html>index")
			}),
		},
		limiter: auth.NewRateLimiter(auth.DefaultLoginAttempts, auth.DefaultLoginWindow),
	}
	for _, opt := range opts {
		opt(&o)
	}

	dir := t.TempDir()
	st, err := store.NewFS(dir)
	if err != nil {
		t.Fatalf("NewFS: %v", err)
	}
	creds, err := auth.LoadCredentials(filepath.Join(dir, "auth.json"))
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	srv := httptest.NewServer(server.New(o.cfg, st, creds, auth.NewSessionStore(time.Hour, 24*time.Hour), o.limiter))
	t.Cleanup(srv.Close)

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}
	return &harness{t: t, url: srv.URL, client: &http.Client{Jar: jar}, dataDir: dir}
}

// loggedIn returns a harness that has completed setup and holds a session.
func loggedIn(t *testing.T, opts ...func(*options)) *harness {
	t.Helper()
	h := newHarness(t, opts...)
	h.mustStatus(h.setup(authKey(1)), http.StatusCreated)
	h.mustStatus(h.login(authKey(1)), http.StatusNoContent)
	return h
}

type response struct {
	status int
	header http.Header
	body   []byte
}

// do performs a request. Extra arguments are header key/value pairs.
func (h *harness) do(method, path string, body io.Reader, header ...string) response {
	h.t.Helper()
	req, err := http.NewRequest(method, h.url+path, body)
	if err != nil {
		h.t.Fatalf("new request: %v", err)
	}
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	resp, err := h.client.Do(req)
	if err != nil {
		h.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		h.t.Fatalf("read body: %v", err)
	}
	return response{status: resp.StatusCode, header: resp.Header, body: data}
}

func (h *harness) postJSON(path string, body string, header ...string) response {
	h.t.Helper()
	return h.do(http.MethodPost, path, strings.NewReader(body),
		append([]string{"Content-Type", "application/json"}, header...)...)
}

func (h *harness) setup(key string) response {
	h.t.Helper()
	return h.postJSON("/api/setup", `{"auth_key":`+quote(key)+`}`)
}

func (h *harness) login(key string) response {
	h.t.Helper()
	return h.postJSON("/api/login", `{"auth_key":`+quote(key)+`}`)
}

func (h *harness) mustStatus(r response, want int) response {
	h.t.Helper()
	if r.status != want {
		h.t.Fatalf("status = %d (%s), want %d", r.status, bytes.TrimSpace(r.body), want)
	}
	return r
}

func (r response) errorCode(t *testing.T) string {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(r.body, &body); err != nil {
		t.Fatalf("parse error body %q: %v", r.body, err)
	}
	return body.Error
}

func (r response) decode(t *testing.T, v any) {
	t.Helper()
	if err := json.Unmarshal(r.body, v); err != nil {
		t.Fatalf("parse body %q: %v", r.body, err)
	}
}

func quote(s string) string {
	out, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(out)
}

func TestHealth(t *testing.T) {
	h := newHarness(t)

	var health struct {
		Status string `json:"status"`
		Setup  bool   `json:"setup"`
	}
	h.mustStatus(h.do(http.MethodGet, "/api/health", nil), http.StatusOK).decode(t, &health)
	if health.Status != "ok" || health.Setup {
		t.Fatalf("health = %+v, want ok and setup=false", health)
	}

	h.mustStatus(h.setup(authKey(1)), http.StatusCreated)
	h.mustStatus(h.do(http.MethodGet, "/api/health", nil), http.StatusOK).decode(t, &health)
	if !health.Setup {
		t.Fatal("health still reports the archive as not set up")
	}
}

func TestLifecycle(t *testing.T) {
	h := loggedIn(t)

	// No manifest yet.
	h.mustStatus(h.do(http.MethodGet, "/api/manifest", nil), http.StatusNotFound)

	// Create it, then read it back with its ETag.
	var created struct {
		ETag string `json:"etag"`
	}
	h.mustStatus(h.do(http.MethodPut, "/api/manifest", strings.NewReader("manifest-v1")), http.StatusOK).decode(t, &created)
	if created.ETag == "" {
		t.Fatal("empty etag after creating the manifest")
	}
	got := h.mustStatus(h.do(http.MethodGet, "/api/manifest", nil), http.StatusOK)
	if string(got.body) != "manifest-v1" {
		t.Fatalf("manifest = %q, want manifest-v1", got.body)
	}
	if got.header.Get("ETag") != created.ETag {
		t.Fatalf("ETag = %q, want %q", got.header.Get("ETag"), created.ETag)
	}

	// Update it under its ETag.
	var updated struct {
		ETag string `json:"etag"`
	}
	h.mustStatus(h.do(http.MethodPut, "/api/manifest", strings.NewReader("manifest-v2"),
		"If-Match", created.ETag), http.StatusOK).decode(t, &updated)
	if updated.ETag == created.ETag {
		t.Fatal("etag did not change after the update")
	}

	// Blobs: put, get, head.
	id := blobID("a")
	h.mustStatus(h.do(http.MethodPut, "/api/blobs/"+id, strings.NewReader("blob-body")), http.StatusCreated)

	blob := h.mustStatus(h.do(http.MethodGet, "/api/blobs/"+id, nil), http.StatusOK)
	if string(blob.body) != "blob-body" {
		t.Fatalf("blob = %q, want blob-body", blob.body)
	}
	if ct := blob.header.Get("Content-Type"); ct != "application/octet-stream" {
		t.Errorf("Content-Type = %q, want application/octet-stream", ct)
	}

	head := h.mustStatus(h.do(http.MethodHead, "/api/blobs/"+id, nil), http.StatusOK)
	if len(head.body) != 0 {
		t.Errorf("HEAD returned %d bytes of body", len(head.body))
	}
	if head.header.Get("Content-Length") != strconv.Itoa(len("blob-body")) {
		t.Errorf("HEAD Content-Length = %q, want %d", head.header.Get("Content-Length"), len("blob-body"))
	}
	h.mustStatus(h.do(http.MethodHead, "/api/blobs/"+blobID("b"), nil), http.StatusNotFound)

	// Batch existence, order preserved, unknown ids left out.
	var exists struct {
		Exists []string `json:"exists"`
	}
	h.mustStatus(h.postJSON("/api/blobs/exists",
		`{"ids":[`+quote(blobID("b"))+`,`+quote(id)+`,`+quote(blobID("c"))+`]}`),
		http.StatusOK).decode(t, &exists)
	if len(exists.Exists) != 1 || exists.Exists[0] != id {
		t.Fatalf("exists = %v, want [%s…]", exists.Exists, id[:4])
	}

	// Listing.
	var list struct {
		IDs []string `json:"ids"`
	}
	h.mustStatus(h.do(http.MethodGet, "/api/blobs", nil), http.StatusOK).decode(t, &list)
	if len(list.IDs) != 1 || list.IDs[0] != id {
		t.Fatalf("ids = %v, want [%s…]", list.IDs, id[:4])
	}

	// Logout ends the session.
	h.mustStatus(h.do(http.MethodPost, "/api/logout", nil), http.StatusNoContent)
	h.mustStatus(h.do(http.MethodGet, "/api/manifest", nil), http.StatusUnauthorized)
}

func TestSetupErrors(t *testing.T) {
	h := newHarness(t)

	if got := h.mustStatus(h.setup("not-base64!"), http.StatusBadRequest).errorCode(t); got != "invalid_auth_key" {
		t.Errorf("error = %q, want invalid_auth_key", got)
	}
	h.mustStatus(h.setup(base64.StdEncoding.EncodeToString([]byte("short"))), http.StatusBadRequest)
	h.mustStatus(h.postJSON("/api/setup", `{"auth_key":"x"`), http.StatusBadRequest)
	h.mustStatus(h.postJSON("/api/setup", `{"unknown":"x"}`), http.StatusBadRequest)

	// A rejected setup leaves the archive claimable; the first account wins.
	h.mustStatus(h.setup(authKey(1)), http.StatusCreated)
	if got := h.mustStatus(h.setup(authKey(2)), http.StatusConflict).errorCode(t); got != "already_setup" {
		t.Errorf("error = %q, want already_setup", got)
	}
	// The first key is the one that works.
	h.mustStatus(h.login(authKey(2)), http.StatusUnauthorized)
	h.mustStatus(h.login(authKey(1)), http.StatusNoContent)
}

func TestLoginErrors(t *testing.T) {
	h := newHarness(t)
	if got := h.mustStatus(h.login(authKey(1)), http.StatusConflict).errorCode(t); got != "not_setup" {
		t.Errorf("error = %q, want not_setup", got)
	}

	h.mustStatus(h.setup(authKey(1)), http.StatusCreated)
	if got := h.mustStatus(h.login(authKey(9)), http.StatusUnauthorized).errorCode(t); got != "unauthorized" {
		t.Errorf("error = %q, want unauthorized", got)
	}
	h.mustStatus(h.login("not-base64!"), http.StatusUnauthorized)
}

func TestLoginRateLimit(t *testing.T) {
	// Setup shares the limiter and spends the first attempt.
	h := newHarness(t, func(o *options) {
		o.limiter = auth.NewRateLimiter(4, time.Minute)
	})
	h.mustStatus(h.setup(authKey(1)), http.StatusCreated)

	for range 3 {
		h.mustStatus(h.login(authKey(9)), http.StatusUnauthorized)
	}
	if got := h.mustStatus(h.login(authKey(9)), http.StatusTooManyRequests).errorCode(t); got != "rate_limited" {
		t.Errorf("error = %q, want rate_limited", got)
	}
	// Even the right key is refused while the window lasts.
	h.mustStatus(h.login(authKey(1)), http.StatusTooManyRequests)
}

func TestSetupRateLimit(t *testing.T) {
	h := newHarness(t, func(o *options) {
		o.limiter = auth.NewRateLimiter(3, time.Minute)
	})

	for range 3 {
		h.mustStatus(h.setup("not-base64!"), http.StatusBadRequest)
	}
	// A valid key is refused too: the limit counts attempts, not failures.
	if got := h.mustStatus(h.setup(authKey(1)), http.StatusTooManyRequests).errorCode(t); got != "rate_limited" {
		t.Errorf("error = %q, want rate_limited", got)
	}
}

func TestSessionCookieAttributes(t *testing.T) {
	for _, secure := range []bool{false, true} {
		h := newHarness(t, func(o *options) { o.cfg.Secure = secure })
		h.mustStatus(h.setup(authKey(1)), http.StatusCreated)

		req, err := http.NewRequest(http.MethodPost, h.url+"/api/login", strings.NewReader(`{"auth_key":`+quote(authKey(1))+`}`))
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		resp, err := h.client.Do(req)
		if err != nil {
			t.Fatalf("login: %v", err)
		}
		_ = resp.Body.Close()

		cookies := resp.Cookies()
		if len(cookies) != 1 {
			t.Fatalf("got %d cookies, want 1", len(cookies))
		}
		c := cookies[0]
		if c.Name != "mailarchive_session" || c.Value == "" {
			t.Errorf("cookie = %s=%q", c.Name, c.Value)
		}
		if !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" {
			t.Errorf("cookie flags: HttpOnly=%v SameSite=%v Path=%q", c.HttpOnly, c.SameSite, c.Path)
		}
		if c.Secure != secure {
			t.Errorf("cookie Secure = %v, want %v", c.Secure, secure)
		}
	}
}

func TestAuthenticationRequired(t *testing.T) {
	h := newHarness(t)
	h.mustStatus(h.setup(authKey(1)), http.StatusCreated)

	id := blobID("a")
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/manifest"},
		{http.MethodPut, "/api/manifest"},
		{http.MethodGet, "/api/blobs"},
		{http.MethodPost, "/api/blobs/exists"},
		{http.MethodGet, "/api/blobs/" + id},
		{http.MethodHead, "/api/blobs/" + id},
		{http.MethodPut, "/api/blobs/" + id},
		{http.MethodPost, "/api/logout"},
	} {
		r := h.do(tc.method, tc.path, strings.NewReader("{}"))
		if r.status != http.StatusUnauthorized {
			t.Errorf("%s %s = %d, want 401", tc.method, tc.path, r.status)
		}
	}

	// An unknown or forged cookie is not a session either.
	r := h.do(http.MethodGet, "/api/blobs", nil, "Cookie", "mailarchive_session=forged")
	if r.status != http.StatusUnauthorized {
		t.Errorf("forged cookie = %d, want 401", r.status)
	}
}

func TestManifestPreconditions(t *testing.T) {
	h := loggedIn(t)

	var created struct {
		ETag string `json:"etag"`
	}
	h.mustStatus(h.do(http.MethodPut, "/api/manifest", strings.NewReader("v1")), http.StatusOK).decode(t, &created)

	got := h.mustStatus(h.do(http.MethodPut, "/api/manifest", strings.NewReader("v2")), http.StatusPreconditionRequired)
	if code := got.errorCode(t); code != "if_match_required" {
		t.Errorf("error = %q, want if_match_required", code)
	}
	got = h.mustStatus(h.do(http.MethodPut, "/api/manifest", strings.NewReader("v2"),
		"If-Match", `"0000"`), http.StatusPreconditionFailed)
	if code := got.errorCode(t); code != "conflict" {
		t.Errorf("error = %q, want conflict", code)
	}

	// The manifest is untouched by the rejected writes.
	if body := h.mustStatus(h.do(http.MethodGet, "/api/manifest", nil), http.StatusOK).body; string(body) != "v1" {
		t.Fatalf("manifest = %q, want v1", body)
	}
}

func TestManifestTooLarge(t *testing.T) {
	h := loggedIn(t, func(o *options) { o.cfg.MaxManifestBytes = 16 })

	r := h.do(http.MethodPut, "/api/manifest", strings.NewReader(strings.Repeat("x", 64)))
	if r.status != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", r.status)
	}
	if code := r.errorCode(t); code != "too_large" {
		t.Errorf("error = %q, want too_large", code)
	}
	h.mustStatus(h.do(http.MethodGet, "/api/manifest", nil), http.StatusNotFound)
}

func TestBlobWriteOnce(t *testing.T) {
	h := loggedIn(t)
	id := blobID("a")

	h.mustStatus(h.do(http.MethodPut, "/api/blobs/"+id, strings.NewReader("first")), http.StatusCreated)
	r := h.do(http.MethodPut, "/api/blobs/"+id, strings.NewReader("second"))
	if r.status != http.StatusConflict {
		t.Fatalf("status = %d, want 409", r.status)
	}
	if code := r.errorCode(t); code != "exists" {
		t.Errorf("error = %q, want exists", code)
	}
	if body := h.mustStatus(h.do(http.MethodGet, "/api/blobs/"+id, nil), http.StatusOK).body; string(body) != "first" {
		t.Fatalf("blob = %q, want first", body)
	}
}

func TestBlobInvalidIDs(t *testing.T) {
	h := loggedIn(t)

	for _, id := range []string{
		strings.Repeat("a", 63),
		strings.Repeat("a", 65),
		strings.Repeat("A", 64),
		strings.Repeat("a", 62) + "%2F",
		"%2e%2e%2f" + strings.Repeat("a", 55),
	} {
		for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPut} {
			r := h.do(method, "/api/blobs/"+id, strings.NewReader("x"))
			if r.status != http.StatusBadRequest {
				t.Errorf("%s /api/blobs/%s = %d, want 400", method, id, r.status)
			}
		}
	}

	// Nothing reached the filesystem.
	entries, err := os.ReadDir(filepath.Join(h.dataDir, "blobs"))
	if err != nil {
		t.Fatalf("read blobs dir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("blobs dir holds %d entries, want none", len(entries))
	}
}

func TestBlobTooLarge(t *testing.T) {
	h := loggedIn(t, func(o *options) { o.cfg.MaxBlobBytes = 8 })
	id := blobID("a")

	r := h.do(http.MethodPut, "/api/blobs/"+id, strings.NewReader(strings.Repeat("x", 64)))
	if r.status != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", r.status)
	}
	if code := r.errorCode(t); code != "too_large" {
		t.Errorf("error = %q, want too_large", code)
	}
	h.mustStatus(h.do(http.MethodGet, "/api/blobs/"+id, nil), http.StatusNotFound)
}

func TestBlobsExistValidation(t *testing.T) {
	h := loggedIn(t, func(o *options) { o.cfg.MaxExistsIDs = 2 })

	if code := h.mustStatus(h.postJSON("/api/blobs/exists",
		`{"ids":[`+quote(blobID("a"))+`,`+quote(blobID("b"))+`,`+quote(blobID("c"))+`]}`),
		http.StatusBadRequest).errorCode(t); code != "too_many_ids" {
		t.Errorf("error = %q, want too_many_ids", code)
	}
	if code := h.mustStatus(h.postJSON("/api/blobs/exists", `{"ids":["../etc/passwd"]}`),
		http.StatusBadRequest).errorCode(t); code != "invalid_id" {
		t.Errorf("error = %q, want invalid_id", code)
	}
	h.mustStatus(h.postJSON("/api/blobs/exists", `{"unknown":[]}`), http.StatusBadRequest)

	// An empty list is valid and returns an empty array, never null.
	r := h.mustStatus(h.postJSON("/api/blobs/exists", `{"ids":[]}`), http.StatusOK)
	if string(r.body) != `{"exists":[]}` {
		t.Errorf("body = %s, want {\"exists\":[]}", r.body)
	}
}

func TestCSRFProtection(t *testing.T) {
	h := loggedIn(t)
	id := blobID("a")

	rejected := [][]string{
		{"Sec-Fetch-Site", "cross-site"},
		{"Sec-Fetch-Site", "same-site"},
		{"Origin", "https://evil.example"},
	}
	for _, header := range rejected {
		r := h.do(http.MethodPut, "/api/blobs/"+id, strings.NewReader("x"), header...)
		if r.status != http.StatusForbidden {
			t.Errorf("PUT with %v = %d, want 403", header, r.status)
		}
		r = h.postJSON("/api/logout", "", header...)
		if r.status != http.StatusForbidden {
			t.Errorf("POST with %v = %d, want 403", header, r.status)
		}
	}

	// Reads are never blocked, and same-origin writes go through.
	h.mustStatus(h.do(http.MethodGet, "/api/blobs", nil, "Sec-Fetch-Site", "cross-site"), http.StatusOK)
	h.mustStatus(h.do(http.MethodPut, "/api/blobs/"+id, strings.NewReader("x"),
		"Sec-Fetch-Site", "same-origin"), http.StatusCreated)
	h.mustStatus(h.do(http.MethodPut, "/api/blobs/"+blobID("b"), strings.NewReader("x"),
		"Origin", h.url), http.StatusCreated)
	// Sec-Fetch-Site wins over a mismatched Origin, as the browser sets it.
	h.mustStatus(h.do(http.MethodPut, "/api/blobs/"+blobID("c"), strings.NewReader("x"),
		"Sec-Fetch-Site", "same-origin", "Origin", "https://evil.example"), http.StatusCreated)
}

func TestSecurityHeaders(t *testing.T) {
	h := newHarness(t)

	api := h.do(http.MethodGet, "/api/health", nil)
	for key, want := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "no-referrer",
		"X-Frame-Options":        "DENY",
		"Cache-Control":          "no-store",
	} {
		if got := api.header.Get(key); got != want {
			t.Errorf("api %s = %q, want %q", key, got, want)
		}
	}
	if csp := api.header.Get("Content-Security-Policy"); csp != "" {
		t.Errorf("api Content-Security-Policy = %q, want none", csp)
	}

	ui := h.do(http.MethodGet, "/", nil)
	csp := ui.header.Get("Content-Security-Policy")
	for _, directive := range []string{"default-src 'self'", "frame-ancestors 'none'", "base-uri 'none'"} {
		if !strings.Contains(csp, directive) {
			t.Errorf("Content-Security-Policy %q is missing %q", csp, directive)
		}
	}
	if got := ui.header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("ui X-Content-Type-Options = %q, want nosniff", got)
	}
}

func TestRouting(t *testing.T) {
	h := newHarness(t)

	// Unknown API paths answer in JSON, never with the app shell.
	r := h.do(http.MethodGet, "/api/nope", nil)
	if r.status != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", r.status)
	}
	if code := r.errorCode(t); code != "not_found" {
		t.Errorf("error = %q, want not_found", code)
	}

	// Unknown app paths fall back to the SPA.
	for _, path := range []string{"/", "/messages/123", "/settings"} {
		r := h.do(http.MethodGet, path, nil)
		if r.status != http.StatusOK || !strings.Contains(string(r.body), "index") {
			t.Errorf("GET %s = %d %q, want the app shell", path, r.status, r.body)
		}
	}

	// Without a UI handler the same paths 404.
	bare := newHarness(t, func(o *options) { o.cfg.UI = nil })
	if r := bare.do(http.MethodGet, "/messages/123", nil); r.status != http.StatusNotFound {
		t.Errorf("status without a UI = %d, want 404", r.status)
	}
}

// An unsupported method on a known API path is handled by the /api/ catch-all,
// so it reads as a missing endpoint rather than a wrong method.
func TestUnknownAPIMethod(t *testing.T) {
	h := loggedIn(t)
	r := h.do(http.MethodDelete, "/api/manifest", nil)
	if r.status != http.StatusNotFound {
		t.Fatalf("DELETE /api/manifest = %d, want 404", r.status)
	}
	if code := r.errorCode(t); code != "not_found" {
		t.Errorf("error = %q, want not_found", code)
	}
}
