package server_test

import (
	"bytes"
	"context"
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

// recoveryKey is the recovery auth key loggedIn registers, far from the small
// seeds tests use for passphrase keys and wrong keys.
var recoveryKey = authKey(200)

// defaultKDF is what loggedIn registers, already compact.
const defaultKDF = `{"name":"argon2id","m":65536,"t":3,"p":1,"salt":"AAAA"}`

// setupManifest is the manifest the setup helper stores.
var setupManifest = envelope("v0")

// envelope builds a manifest as the client stores it: the header the server
// holds session-only writes to, around a body standing in for the sealed one.
func envelope(body string) string {
	return `{"version":1,"kdf":` + defaultKDF + `,"wrapped":{"passphrase":"p","recovery":"r"},"body":` + quote(body) + `}`
}

type harness struct {
	t       *testing.T
	url     string
	client  *http.Client
	dataDir string
	store   *store.FS
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
		// Every client shares the loopback address and setup, login and rekey
		// all spend attempts, so the production limit would trip in longer
		// tests. The rate limit tests set their own.
		limiter: auth.NewRateLimiter(100, auth.DefaultLoginWindow),
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
	t.Cleanup(func() { _ = st.Close() })
	srv := httptest.NewServer(server.New(o.cfg, st, creds, auth.NewSessionStore(time.Hour, 24*time.Hour), o.limiter))
	t.Cleanup(srv.Close)

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}
	return &harness{t: t, url: srv.URL, client: &http.Client{Jar: jar}, dataDir: dir, store: st}
}

// newClient returns a second client of the same server, with its own cookie
// jar and therefore its own session.
func (h *harness) newClient() *harness {
	h.t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		h.t.Fatalf("cookiejar: %v", err)
	}
	return &harness{t: h.t, url: h.url, client: &http.Client{Jar: jar}, dataDir: h.dataDir, store: h.store}
}

// loggedIn returns a harness that has completed setup with authKey(1) and
// recoveryKey and holds a session opened with the passphrase key.
func loggedIn(t *testing.T, opts ...func(*options)) *harness {
	t.Helper()
	h := newHarness(t, opts...)
	h.mustStatus(h.setup(authKey(1), recoveryKey, defaultKDF), http.StatusCreated)
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

// setup registers both auth keys and the KDF parameters, with setupManifest
// as the manifest. kdf is raw JSON, spliced into the body as is, so tests can
// send malformed values.
func (h *harness) setup(authKey, recoveryKey, kdf string) response {
	h.t.Helper()
	return h.postJSON("/api/setup", `{"auth_key":`+quote(authKey)+`,"recovery_auth_key":`+quote(recoveryKey)+
		`,"kdf":`+kdf+`,"manifest":`+quote(b64(setupManifest))+`}`)
}

// rekeyRequest is one POST /api/rekey body. Empty strings are left out of the
// body, and kdf is spliced in as raw JSON. current is the credential the
// caller proves possession of.
type rekeyRequest struct {
	current, authKey, recoveryKey, kdf, manifest, ifMatch string
}

func (h *harness) rekey(req rekeyRequest) response {
	h.t.Helper()
	fields := []string{}
	if req.current != "" {
		fields = append(fields, `"current_auth_key":`+quote(req.current))
	}
	if req.authKey != "" {
		fields = append(fields, `"auth_key":`+quote(req.authKey))
	}
	if req.recoveryKey != "" {
		fields = append(fields, `"recovery_auth_key":`+quote(req.recoveryKey))
	}
	if req.kdf != "" {
		fields = append(fields, `"kdf":`+req.kdf)
	}
	fields = append(fields, `"manifest":`+quote(req.manifest))
	if req.ifMatch != "" {
		fields = append(fields, `"if_match":`+quote(req.ifMatch))
	}
	return h.postJSON("/api/rekey", "{"+strings.Join(fields, ",")+"}")
}

// putManifest replaces the manifest under its current ETag and returns the
// new one.
func (h *harness) putManifest(body string) string {
	h.t.Helper()
	var out struct {
		ETag string `json:"etag"`
	}
	h.mustStatus(h.do(http.MethodPut, "/api/manifest", strings.NewReader(body), "If-Match", h.manifestETag()), http.StatusOK).decode(h.t, &out)
	if out.ETag == "" {
		h.t.Fatal("empty etag after writing the manifest")
	}
	return out.ETag
}

// manifest reads the manifest back.
func (h *harness) manifest() string {
	h.t.Helper()
	return string(h.mustStatus(h.do(http.MethodGet, "/api/manifest", nil), http.StatusOK).body)
}

// manifestETag reads the current manifest's ETag.
func (h *harness) manifestETag() string {
	h.t.Helper()
	etag := h.mustStatus(h.do(http.MethodGet, "/api/manifest", nil), http.StatusOK).header.Get("ETag")
	if etag == "" {
		h.t.Fatal("manifest served without an ETag")
	}
	return etag
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

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

	h.mustStatus(h.setup(authKey(1), recoveryKey, defaultKDF), http.StatusCreated)
	h.mustStatus(h.do(http.MethodGet, "/api/health", nil), http.StatusOK).decode(t, &health)
	if !health.Setup {
		t.Fatal("health still reports the archive as not set up")
	}
}

func TestLifecycle(t *testing.T) {
	h := loggedIn(t)

	// Setup stored the manifest; read it back with its ETag.
	got := h.mustStatus(h.do(http.MethodGet, "/api/manifest", nil), http.StatusOK)
	if string(got.body) != setupManifest {
		t.Fatalf("manifest = %q, want %q", got.body, setupManifest)
	}
	created := got.header.Get("ETag")
	if created == "" {
		t.Fatal("manifest served without an ETag")
	}

	// Update it under its ETag.
	var updated struct {
		ETag string `json:"etag"`
	}
	h.mustStatus(h.do(http.MethodPut, "/api/manifest", strings.NewReader(envelope("v1")),
		"If-Match", created), http.StatusOK).decode(t, &updated)
	if updated.ETag == "" || updated.ETag == created {
		t.Fatalf("etag after the update = %q, want a new one", updated.ETag)
	}
	got = h.mustStatus(h.do(http.MethodGet, "/api/manifest", nil), http.StatusOK)
	if string(got.body) != envelope("v1") || got.header.Get("ETag") != updated.ETag {
		t.Fatalf("manifest = %q with ETag %q, want manifest-v1 with %q", got.body, got.header.Get("ETag"), updated.ETag)
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

	if got := h.mustStatus(h.setup("not-base64!", recoveryKey, defaultKDF), http.StatusBadRequest).errorCode(t); got != "invalid_auth_key" {
		t.Errorf("error = %q, want invalid_auth_key", got)
	}
	h.mustStatus(h.setup(base64.StdEncoding.EncodeToString([]byte("short")), recoveryKey, defaultKDF), http.StatusBadRequest)
	h.mustStatus(h.postJSON("/api/setup", `{"auth_key":"x"`), http.StatusBadRequest)
	h.mustStatus(h.postJSON("/api/setup", `{"unknown":"x"}`), http.StatusBadRequest)

	// The recovery key is mandatory and validated the same way.
	if got := h.mustStatus(h.postJSON("/api/setup",
		`{"auth_key":`+quote(authKey(1))+`,"kdf":`+defaultKDF+`,"manifest":`+quote(b64(setupManifest))+`}`),
		http.StatusBadRequest).errorCode(t); got != "invalid_auth_key" {
		t.Errorf("missing recovery key: error = %q, want invalid_auth_key", got)
	}
	h.mustStatus(h.setup(authKey(1), "not-base64!", defaultKDF), http.StatusBadRequest)

	// A rejected setup leaves the archive claimable; the first account wins.
	h.mustStatus(h.setup(authKey(1), recoveryKey, defaultKDF), http.StatusCreated)
	if got := h.mustStatus(h.setup(authKey(2), authKey(3), defaultKDF), http.StatusConflict).errorCode(t); got != "already_setup" {
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

	h.mustStatus(h.setup(authKey(1), recoveryKey, defaultKDF), http.StatusCreated)
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
	h.mustStatus(h.setup(authKey(1), recoveryKey, defaultKDF), http.StatusCreated)

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
	limiter := auth.NewRateLimiter(1, time.Minute)
	h := newHarness(t, func(o *options) { o.limiter = limiter })

	// Only a setup that passes validation reaches the limiter, and a valid
	// one claims the archive, so the single attempt is spent directly for the
	// loopback address the test client arrives from.
	limiter.Allow("127.0.0.1")
	if got := h.mustStatus(h.setup(authKey(1), recoveryKey, defaultKDF), http.StatusTooManyRequests).errorCode(t); got != "rate_limited" {
		t.Errorf("error = %q, want rate_limited", got)
	}
	h.mustNotSetup()
}

// mustNotSetup asserts that no setup attempt claimed the archive: neither the
// credentials nor a manifest exist.
func (h *harness) mustNotSetup() {
	h.t.Helper()
	for _, name := range []string{"auth.json", "manifest"} {
		if _, err := os.Stat(filepath.Join(h.dataDir, name)); err == nil {
			h.t.Fatalf("%s exists after a rejected setup", name)
		}
	}
}

func TestSetupManifest(t *testing.T) {
	want := envelope("y")
	h := newHarness(t, func(o *options) { o.cfg.MaxManifestBytes = int64(len(want)) })
	fields := `"auth_key":` + quote(authKey(1)) + `,"recovery_auth_key":` + quote(recoveryKey) + `,"kdf":` + defaultKDF

	if got := h.mustStatus(h.postJSON("/api/setup", `{`+fields+`}`), http.StatusBadRequest).errorCode(t); got != "bad_request" {
		t.Errorf("missing manifest: error = %q, want bad_request", got)
	}
	h.mustNotSetup()
	if got := h.mustStatus(h.postJSON("/api/setup", `{`+fields+`,"manifest":"not base64!"}`), http.StatusBadRequest).errorCode(t); got != "bad_request" {
		t.Errorf("bad manifest: error = %q, want bad_request", got)
	}
	// Bytes that are not a manifest envelope: the server holds the kdf and
	// wrapped fields of every later session-only write to the stored ones,
	// so it must be able to read them off what setup stores.
	for name, manifest := range map[string]string{
		"not json":       "nonsense",
		"not an object":  `["kdf"]`,
		"no wrapped":     `{"version":1,"kdf":` + defaultKDF + `,"body":"x"}`,
		"no kdf":         `{"version":1,"wrapped":{"passphrase":"p","recovery":"r"},"body":"x"}`,
		"kdf not object": `{"version":1,"kdf":1,"wrapped":{},"body":"x"}`,
	} {
		if got := h.mustStatus(h.postJSON("/api/setup", `{`+fields+`,"manifest":`+quote(b64(manifest))+`}`), http.StatusBadRequest).errorCode(t); got != "bad_request" {
			t.Errorf("%s: error = %q, want bad_request", name, got)
		}
	}
	// Over the limit, whether it fits the body limit or not.
	if got := h.mustStatus(h.postJSON("/api/setup", `{`+fields+`,"manifest":`+quote(b64(envelope("yy")))+`}`),
		http.StatusRequestEntityTooLarge).errorCode(t); got != "too_large" {
		t.Errorf("large manifest: error = %q, want too_large", got)
	}
	h.mustStatus(h.postJSON("/api/setup", `{`+fields+`,"manifest":`+quote(b64(envelope(strings.Repeat("x", 64<<10))))+`}`),
		http.StatusRequestEntityTooLarge)
	h.mustNotSetup()

	// Exactly at the limit goes through, and login reads it back verbatim.
	h.mustStatus(h.postJSON("/api/setup", `{`+fields+`,"manifest":`+quote(b64(want))+`}`), http.StatusCreated)
	h.mustStatus(h.login(authKey(1)), http.StatusNoContent)
	got := h.mustStatus(h.do(http.MethodGet, "/api/manifest", nil), http.StatusOK)
	if string(got.body) != want {
		t.Errorf("manifest = %q, want %q", got.body, want)
	}
	if got.header.Get("ETag") == "" {
		t.Error("manifest served without an ETag")
	}
}

// A setup that crashed between writing the manifest and the credentials
// leaves an orphan manifest; the next setup replaces it.
func TestSetupOverwritesOrphanManifest(t *testing.T) {
	h := newHarness(t)
	if _, err := h.store.PutManifest(context.Background(), []byte("orphan"), ""); err != nil {
		t.Fatalf("plant orphan manifest: %v", err)
	}

	h.mustStatus(h.setup(authKey(1), recoveryKey, defaultKDF), http.StatusCreated)
	h.mustStatus(h.login(authKey(1)), http.StatusNoContent)
	if got := h.manifest(); got != setupManifest {
		t.Errorf("manifest = %q, want %q", got, setupManifest)
	}
}

func TestSessionCookieAttributes(t *testing.T) {
	for _, secure := range []bool{false, true} {
		h := newHarness(t, func(o *options) { o.cfg.Secure = secure })
		h.mustStatus(h.setup(authKey(1), recoveryKey, defaultKDF), http.StatusCreated)

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
	h.mustStatus(h.setup(authKey(1), recoveryKey, defaultKDF), http.StatusCreated)

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
		{http.MethodPost, "/api/rekey"},
		{http.MethodGet, "/api/session/key"},
		{http.MethodPut, "/api/session/key"},
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
	h.putManifest(envelope("v1"))

	got := h.mustStatus(h.do(http.MethodPut, "/api/manifest", strings.NewReader(envelope("v2"))), http.StatusPreconditionRequired)
	if code := got.errorCode(t); code != "if_match_required" {
		t.Errorf("error = %q, want if_match_required", code)
	}
	got = h.mustStatus(h.do(http.MethodPut, "/api/manifest", strings.NewReader(envelope("v2")),
		"If-Match", `"0000"`), http.StatusPreconditionFailed)
	if code := got.errorCode(t); code != "conflict" {
		t.Errorf("error = %q, want conflict", code)
	}

	// The manifest is untouched by the rejected writes.
	if body := h.mustStatus(h.do(http.MethodGet, "/api/manifest", nil), http.StatusOK).body; string(body) != envelope("v1") {
		t.Fatalf("manifest = %q, want v1", body)
	}
}

func TestManifestTooLarge(t *testing.T) {
	h := loggedIn(t, func(o *options) { o.cfg.MaxManifestBytes = int64(len(setupManifest)) })

	r := h.do(http.MethodPut, "/api/manifest", strings.NewReader(envelope("v0x")), "If-Match", h.manifestETag())
	if r.status != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", r.status)
	}
	if code := r.errorCode(t); code != "too_large" {
		t.Errorf("error = %q, want too_large", code)
	}
	if got := h.manifest(); got != setupManifest {
		t.Errorf("manifest = %q, want %q", got, setupManifest)
	}
}

// Setup always stores a manifest, so only its disappearance from disk makes
// GET answer 404.
func TestManifestMissing(t *testing.T) {
	h := loggedIn(t)
	if err := os.Remove(filepath.Join(h.dataDir, "manifest")); err != nil {
		t.Fatalf("remove manifest: %v", err)
	}
	if got := h.mustStatus(h.do(http.MethodGet, "/api/manifest", nil), http.StatusNotFound).errorCode(t); got != "not_found" {
		t.Errorf("error = %q, want not_found", got)
	}
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
	// The Content-Security-Policy belongs to the web app, which authors it at
	// build time and serves it with the shell; see the web package.
	if csp := api.header.Get("Content-Security-Policy"); csp != "" {
		t.Errorf("api Content-Security-Policy = %q, want none", csp)
	}

	ui := h.do(http.MethodGet, "/", nil)
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

func TestKDF(t *testing.T) {
	h := newHarness(t)

	if got := h.mustStatus(h.do(http.MethodGet, "/api/kdf", nil), http.StatusConflict).errorCode(t); got != "not_setup" {
		t.Errorf("error = %q, want not_setup", got)
	}

	// Stored compacted, served verbatim, without a session.
	spaced := `{ "name": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": "AAAA" }`
	h.mustStatus(h.setup(authKey(1), recoveryKey, spaced), http.StatusCreated)
	r := h.mustStatus(h.do(http.MethodGet, "/api/kdf", nil), http.StatusOK)
	if string(r.body) != defaultKDF {
		t.Errorf("kdf = %s, want %s", r.body, defaultKDF)
	}
	if ct := r.header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	if r.header.Get("Cache-Control") != "no-store" {
		t.Error("kdf is cacheable")
	}

	h.mustStatus(h.login(authKey(1)), http.StatusNoContent)
	if body := h.mustStatus(h.do(http.MethodGet, "/api/kdf", nil), http.StatusOK).body; string(body) != defaultKDF {
		t.Errorf("kdf after login = %s, want %s", body, defaultKDF)
	}
}

func TestSetupRejectsBadKDF(t *testing.T) {
	h := newHarness(t)
	for name, kdf := range map[string]string{
		"missing":   "",
		"string":    `"argon2id"`,
		"null":      `null`,
		"array":     `[1,2]`,
		"too large": `{"salt":"` + strings.Repeat("A", auth.MaxKDFBytes) + `"}`,
	} {
		body := `{"auth_key":` + quote(authKey(1)) + `,"recovery_auth_key":` + quote(recoveryKey) + `,"manifest":` + quote(b64(setupManifest)) + `}`
		if kdf != "" {
			body = `{"auth_key":` + quote(authKey(1)) + `,"recovery_auth_key":` + quote(recoveryKey) + `,"kdf":` + kdf +
				`,"manifest":` + quote(b64(setupManifest)) + `}`
		}
		r := h.mustStatus(h.postJSON("/api/setup", body), http.StatusBadRequest)
		if got := r.errorCode(t); got != "invalid_kdf" {
			t.Errorf("%s kdf: error = %q, want invalid_kdf", name, got)
		}
	}
	// Invalid JSON inside the object fails to parse as a body at all.
	h.mustStatus(h.setup(authKey(1), recoveryKey, `{"name":`), http.StatusBadRequest)

	// Nothing above claimed the archive.
	h.mustStatus(h.do(http.MethodGet, "/api/kdf", nil), http.StatusConflict)
	h.mustStatus(h.setup(authKey(1), recoveryKey, defaultKDF), http.StatusCreated)
}

func TestLoginAcceptsEitherKey(t *testing.T) {
	h := newHarness(t)
	h.mustStatus(h.setup(authKey(1), recoveryKey, defaultKDF), http.StatusCreated)

	h.mustStatus(h.login(authKey(1)), http.StatusNoContent)
	h.mustStatus(h.do(http.MethodGet, "/api/blobs", nil), http.StatusOK)
	h.mustStatus(h.do(http.MethodPost, "/api/logout", nil), http.StatusNoContent)

	h.mustStatus(h.login(recoveryKey), http.StatusNoContent)
	h.mustStatus(h.do(http.MethodGet, "/api/blobs", nil), http.StatusOK)
	h.mustStatus(h.do(http.MethodPost, "/api/logout", nil), http.StatusNoContent)

	h.mustStatus(h.login(authKey(3)), http.StatusUnauthorized)
	h.mustStatus(h.do(http.MethodGet, "/api/blobs", nil), http.StatusUnauthorized)
}

func TestRekey(t *testing.T) {
	h := loggedIn(t)
	etag := h.putManifest(envelope("v1"))

	// New passphrase key.
	var out struct {
		ETag string `json:"etag"`
	}
	r := h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), authKey: authKey(11), manifest: b64(envelope("v2")), ifMatch: etag}), http.StatusOK)
	r.decode(t, &out)
	if out.ETag == "" || out.ETag == etag {
		t.Fatalf("etag after rekey = %q, want a new one", out.ETag)
	}
	if r.header.Get("ETag") != out.ETag {
		t.Errorf("ETag header = %q, want %q", r.header.Get("ETag"), out.ETag)
	}
	if got := h.manifest(); got != envelope("v2") {
		t.Errorf("manifest = %q, want manifest-v2", got)
	}
	// The session that rekeyed stays alive.
	h.mustStatus(h.do(http.MethodGet, "/api/blobs", nil), http.StatusOK)

	other := h.newClient()
	other.mustStatus(other.login(authKey(1)), http.StatusUnauthorized)
	other.mustStatus(other.login(authKey(11)), http.StatusNoContent)
	other.mustStatus(other.login(recoveryKey), http.StatusNoContent)
	etag = out.ETag

	// New recovery key only, proven with the rotated passphrase key.
	h.mustStatus(h.rekey(rekeyRequest{current: authKey(11), recoveryKey: authKey(12), manifest: b64(envelope("v3")), ifMatch: etag}), http.StatusOK).decode(t, &out)
	etag = out.ETag
	other.mustStatus(other.login(recoveryKey), http.StatusUnauthorized)
	other.mustStatus(other.login(authKey(12)), http.StatusNoContent)
	other.mustStatus(other.login(authKey(11)), http.StatusNoContent)
	if got := h.manifest(); got != envelope("v3") {
		t.Errorf("manifest = %q, want manifest-v3", got)
	}

	// New kdf only, sent with whitespace and served compacted.
	newKDF := `{"name":"argon2id","m":262144,"t":4,"p":2,"salt":"BBBB"}`
	h.mustStatus(h.rekey(rekeyRequest{current: authKey(11), kdf: `{ "name": "argon2id", "m": 262144, "t": 4, "p": 2, "salt": "BBBB" }`,
		manifest: b64(envelope("v4")), ifMatch: etag}), http.StatusOK).decode(t, &out)
	if body := h.mustStatus(h.do(http.MethodGet, "/api/kdf", nil), http.StatusOK).body; string(body) != newKDF {
		t.Errorf("kdf = %s, want %s", body, newKDF)
	}
	if got := h.manifest(); got != envelope("v4") {
		t.Errorf("manifest = %q, want manifest-v4", got)
	}

	// The rotation survived on disk: only hashes and the kdf are stored.
	data, err := os.ReadFile(filepath.Join(h.dataDir, "auth.json"))
	if err != nil {
		t.Fatalf("read auth.json: %v", err)
	}
	for _, secret := range []string{authKey(1), authKey(11), authKey(12), recoveryKey} {
		if bytes.Contains(data, []byte(secret)) {
			t.Fatal("auth.json contains an auth key")
		}
	}
	creds, err := auth.LoadCredentials(filepath.Join(h.dataDir, "auth.json"))
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	for _, key := range []string{authKey(11), authKey(12)} {
		raw, _ := base64.StdEncoding.DecodeString(key)
		if !creds.Verify(raw) {
			t.Error("reloaded credentials reject a rotated key")
		}
	}
	if string(creds.KDF()) != newKDF {
		t.Errorf("reloaded kdf = %s, want %s", creds.KDF(), newKDF)
	}
}

func TestRekeyErrors(t *testing.T) {
	h := loggedIn(t, func(o *options) { o.cfg.MaxManifestBytes = int64(len(envelope("v1"))) })
	etag := h.putManifest(envelope("v1"))

	unchanged := func(context string) {
		t.Helper()
		if got := h.manifest(); got != envelope("v1") {
			t.Errorf("%s: manifest = %q, want manifest-v1", context, got)
		}
		other := h.newClient()
		other.mustStatus(other.login(authKey(1)), http.StatusNoContent)
	}

	// The session is not enough: the current credential is mandatory, and it
	// must be a valid one.
	r := h.mustStatus(h.rekey(rekeyRequest{authKey: authKey(11), manifest: b64(envelope("x")), ifMatch: etag}), http.StatusBadRequest)
	if got := r.errorCode(t); got != "invalid_auth_key" {
		t.Errorf("missing current key: error = %q, want invalid_auth_key", got)
	}
	unchanged("missing current key")
	r = h.mustStatus(h.rekey(rekeyRequest{current: authKey(9), authKey: authKey(11), manifest: b64(envelope("x")), ifMatch: etag}), http.StatusUnauthorized)
	if got := r.errorCode(t); got != "wrong_credential" {
		t.Errorf("wrong current key: error = %q, want wrong_credential", got)
	}
	unchanged("wrong current key")

	// None of the three optional fields.
	r = h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), manifest: b64(envelope("x")), ifMatch: etag}), http.StatusBadRequest)
	if got := r.errorCode(t); got != "bad_request" {
		t.Errorf("no fields: error = %q, want bad_request", got)
	}
	unchanged("no fields")

	// Stale precondition.
	r = h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), authKey: authKey(11), manifest: b64(envelope("x")), ifMatch: `"0000"`}), http.StatusPreconditionFailed)
	if got := r.errorCode(t); got != "conflict" {
		t.Errorf("stale etag: error = %q, want conflict", got)
	}
	unchanged("stale etag")

	// Missing precondition when a manifest exists.
	r = h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), authKey: authKey(11), manifest: b64(envelope("x"))}), http.StatusPreconditionRequired)
	if got := r.errorCode(t); got != "if_match_required" {
		t.Errorf("missing etag: error = %q, want if_match_required", got)
	}
	unchanged("missing etag")

	// Malformed fields.
	r = h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), authKey: authKey(11), manifest: "not base64!", ifMatch: etag}), http.StatusBadRequest)
	if got := r.errorCode(t); got != "bad_request" {
		t.Errorf("bad manifest: error = %q, want bad_request", got)
	}
	r = h.mustStatus(h.rekey(rekeyRequest{current: "not base64!", authKey: authKey(11), manifest: b64(envelope("x")), ifMatch: etag}), http.StatusBadRequest)
	if got := r.errorCode(t); got != "invalid_auth_key" {
		t.Errorf("bad current key: error = %q, want invalid_auth_key", got)
	}
	r = h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), authKey: "not base64!", manifest: b64(envelope("x")), ifMatch: etag}), http.StatusBadRequest)
	if got := r.errorCode(t); got != "invalid_auth_key" {
		t.Errorf("bad auth key: error = %q, want invalid_auth_key", got)
	}
	r = h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), recoveryKey: authKey(11)[:10], manifest: b64(envelope("x")), ifMatch: etag}), http.StatusBadRequest)
	if got := r.errorCode(t); got != "invalid_auth_key" {
		t.Errorf("bad recovery key: error = %q, want invalid_auth_key", got)
	}
	r = h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), kdf: `[1]`, manifest: b64(envelope("x")), ifMatch: etag}), http.StatusBadRequest)
	if got := r.errorCode(t); got != "invalid_kdf" {
		t.Errorf("bad kdf: error = %q, want invalid_kdf", got)
	}
	h.mustStatus(h.postJSON("/api/rekey", `{"current_auth_key":`+quote(authKey(1))+`,"auth_key":`+quote(authKey(11))+`,"unknown":1}`), http.StatusBadRequest)
	unchanged("malformed fields")

	// Manifest over the limit, whether it fits the body limit or not.
	r = h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), authKey: authKey(11), manifest: b64(envelope("v1x")), ifMatch: etag}),
		http.StatusRequestEntityTooLarge)
	if got := r.errorCode(t); got != "too_large" {
		t.Errorf("large manifest: error = %q, want too_large", got)
	}
	h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), authKey: authKey(11), manifest: b64(envelope(strings.Repeat("x", 64<<10))), ifMatch: etag}),
		http.StatusRequestEntityTooLarge)
	unchanged("large manifest")

	// A manifest exactly at the limit goes through.
	h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), authKey: authKey(11), manifest: b64(envelope("y1")), ifMatch: etag}), http.StatusOK)
	if got := h.manifest(); got != envelope("y1") {
		t.Errorf("manifest = %q, want %q", got, envelope("y1"))
	}
}

func TestRekeyRevokesOtherSessions(t *testing.T) {
	h := loggedIn(t)
	etag := h.putManifest(envelope("v1"))

	other := h.newClient()
	other.mustStatus(other.login(authKey(1)), http.StatusNoContent)
	other.mustStatus(other.do(http.MethodPut, "/api/session/key", strings.NewReader(`{"key":`+quote(authKey(9))+`}`)), http.StatusNoContent)
	h.mustStatus(h.do(http.MethodPut, "/api/session/key", strings.NewReader(`{"key":`+quote(authKey(8))+`}`)), http.StatusNoContent)

	h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), authKey: authKey(11), manifest: b64(envelope("v2")), ifMatch: etag}), http.StatusOK)

	other.mustStatus(other.do(http.MethodGet, "/api/blobs", nil), http.StatusUnauthorized)
	other.mustStatus(other.do(http.MethodGet, "/api/session/key", nil), http.StatusUnauthorized)
	h.mustStatus(h.do(http.MethodGet, "/api/blobs", nil), http.StatusOK)
	var key struct {
		Key string `json:"key"`
	}
	h.mustStatus(h.do(http.MethodGet, "/api/session/key", nil), http.StatusOK).decode(t, &key)
	if key.Key != authKey(8) {
		t.Errorf("the rekeying session lost its key: %q", key.Key)
	}

	// A rejected rekey revokes nothing.
	other.mustStatus(other.login(authKey(11)), http.StatusNoContent)
	h.mustStatus(h.rekey(rekeyRequest{current: authKey(11), authKey: authKey(12), manifest: b64(envelope("v3")), ifMatch: `"stale"`}), http.StatusPreconditionFailed)
	h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), authKey: authKey(12), manifest: b64(envelope("v3")), ifMatch: `"stale"`}), http.StatusUnauthorized)
	other.mustStatus(other.do(http.MethodGet, "/api/blobs", nil), http.StatusOK)
}

// The recovery flow holds only the recovery auth key, which is a current
// credential as much as the passphrase one.
func TestRekeyWithRecoveryKey(t *testing.T) {
	h := loggedIn(t)
	etag := h.putManifest(envelope("v1"))

	h.mustStatus(h.rekey(rekeyRequest{current: recoveryKey, authKey: authKey(11), manifest: b64(envelope("v2")), ifMatch: etag}), http.StatusOK)
	if got := h.manifest(); got != envelope("v2") {
		t.Errorf("manifest = %q, want manifest-v2", got)
	}
	other := h.newClient()
	other.mustStatus(other.login(authKey(1)), http.StatusUnauthorized)
	other.mustStatus(other.login(authKey(11)), http.StatusNoContent)
}

func TestRekeyRateLimit(t *testing.T) {
	// Setup and login spend two attempts; three wrong rekeys spend the rest.
	h := loggedIn(t, func(o *options) {
		o.limiter = auth.NewRateLimiter(5, time.Minute)
	})
	etag := h.putManifest(envelope("v1"))

	for range 3 {
		r := h.mustStatus(h.rekey(rekeyRequest{current: authKey(9), authKey: authKey(11), manifest: b64(envelope("x")), ifMatch: etag}), http.StatusUnauthorized)
		if got := r.errorCode(t); got != "wrong_credential" {
			t.Errorf("error = %q, want wrong_credential", got)
		}
	}
	// The right credential is refused too while the window lasts.
	r := h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), authKey: authKey(11), manifest: b64(envelope("x")), ifMatch: etag}), http.StatusTooManyRequests)
	if got := r.errorCode(t); got != "rate_limited" {
		t.Errorf("error = %q, want rate_limited", got)
	}

	// Nothing was written. The credentials are checked from disk, since a
	// login would be rate limited as well.
	if got := h.manifest(); got != envelope("v1") {
		t.Errorf("manifest = %q, want manifest-v1", got)
	}
	creds, err := auth.LoadCredentials(filepath.Join(h.dataDir, "auth.json"))
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	old, _ := base64.StdEncoding.DecodeString(authKey(1))
	if !creds.Verify(old) {
		t.Error("credentials rotated despite the rate limit")
	}
}

func TestSessionKey(t *testing.T) {
	h := loggedIn(t)
	put := func(body string) response {
		t.Helper()
		return h.do(http.MethodPut, "/api/session/key", strings.NewReader(body), "Content-Type", "application/json")
	}
	get := func() response {
		t.Helper()
		return h.do(http.MethodGet, "/api/session/key", nil)
	}

	if got := h.mustStatus(get(), http.StatusNotFound).errorCode(t); got != "not_found" {
		t.Errorf("error = %q, want not_found", got)
	}

	for name, body := range map[string]string{
		"31 bytes":   `{"key":` + quote(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 31))) + `}`,
		"33 bytes":   `{"key":` + quote(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 33))) + `}`,
		"not base64": `{"key":"not base64!"}`,
		"empty":      `{"key":""}`,
		"missing":    `{}`,
	} {
		r := h.mustStatus(put(body), http.StatusBadRequest)
		if got := r.errorCode(t); got != "invalid_session_key" {
			t.Errorf("%s: error = %q, want invalid_session_key", name, got)
		}
	}
	h.mustStatus(put(`{"key":"x"`), http.StatusBadRequest)
	h.mustStatus(put(`{"unknown":"x"}`), http.StatusBadRequest)
	h.mustStatus(get(), http.StatusNotFound)

	var key struct {
		Key string `json:"key"`
	}
	h.mustStatus(put(`{"key":`+quote(authKey(8))+`}`), http.StatusNoContent)
	h.mustStatus(get(), http.StatusOK).decode(t, &key)
	if key.Key != authKey(8) {
		t.Errorf("key = %q, want %q", key.Key, authKey(8))
	}

	// A second PUT replaces the first.
	h.mustStatus(put(`{"key":`+quote(authKey(9))+`}`), http.StatusNoContent)
	h.mustStatus(get(), http.StatusOK).decode(t, &key)
	if key.Key != authKey(9) {
		t.Errorf("key after replacement = %q, want %q", key.Key, authKey(9))
	}

	// Keys are per session: another session does not see it.
	other := h.newClient()
	other.mustStatus(other.login(authKey(1)), http.StatusNoContent)
	other.mustStatus(other.do(http.MethodGet, "/api/session/key", nil), http.StatusNotFound)
	h.mustStatus(get(), http.StatusOK)

	// Logout drops it, and a new session starts without one.
	h.mustStatus(h.do(http.MethodPost, "/api/logout", nil), http.StatusNoContent)
	h.mustStatus(get(), http.StatusUnauthorized)
	h.mustStatus(h.login(authKey(1)), http.StatusNoContent)
	h.mustStatus(get(), http.StatusNotFound)
}
