package server_test

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Angelmmiguel/mailarchive/internal/auth"
)

// A session may append segments to the manifest body, and nothing more: the
// kdf and wrapped fields belong to rekey, which asks for a credential.
func TestPutManifestHoldsHeader(t *testing.T) {
	h := loggedIn(t)
	etag := h.manifestETag()
	refused := func(name, manifest string) {
		t.Helper()
		r := h.mustStatus(h.do(http.MethodPut, "/api/manifest", strings.NewReader(manifest), "If-Match", etag), http.StatusForbidden)
		if got := r.errorCode(t); got != "header_locked" {
			t.Errorf("%s: error = %q, want header_locked", name, got)
		}
	}
	refused("new kdf", `{"version":1,"kdf":{"name":"argon2id","m":8192,"t":1,"p":1,"salt":"AAAA"},"wrapped":{"passphrase":"p","recovery":"r"},"body":"x"}`)
	refused("new wrapped", `{"version":1,"kdf":`+defaultKDF+`,"wrapped":{"passphrase":"P","recovery":"r"},"body":"x"}`)
	refused("wrapped emptied", `{"version":1,"kdf":`+defaultKDF+`,"wrapped":{},"body":"x"}`)
	for name, manifest := range map[string]string{
		"not json":   "nonsense",
		"no wrapped": `{"version":1,"kdf":` + defaultKDF + `,"body":"x"}`,
		"empty":      "",
	} {
		r := h.mustStatus(h.do(http.MethodPut, "/api/manifest", strings.NewReader(manifest), "If-Match", etag), http.StatusBadRequest)
		if got := r.errorCode(t); got != "bad_request" {
			t.Errorf("%s: error = %q, want bad_request", name, got)
		}
	}
	if got := h.manifest(); got != setupManifest {
		t.Fatalf("manifest = %q after refused writes, want %q", got, setupManifest)
	}

	// The comparison is on the values, not the bytes: spacing and field
	// order in the header are the client's business.
	spaced := `{"body":"v1","wrapped":{"recovery":"r","passphrase":"p"},"kdf":{ "name": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": "AAAA" },"version":1}`
	h.mustStatus(h.do(http.MethodPut, "/api/manifest", strings.NewReader(spaced), "If-Match", etag), http.StatusOK)
	if got := h.manifest(); got != spaced {
		t.Fatalf("manifest = %q, want %q", got, spaced)
	}

	// Rekey, with a credential, is how the header changes.
	rotated := `{"version":1,"kdf":{"name":"argon2id","m":8192,"t":1,"p":1,"salt":"BBBB"},"wrapped":{"passphrase":"P","recovery":"r"},"body":"v2"}`
	h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), authKey: authKey(11), manifest: b64(rotated), ifMatch: h.manifestETag()}), http.StatusOK)
	if got := h.manifest(); got != rotated {
		t.Fatalf("manifest after rekey = %q, want %q", got, rotated)
	}
	// And the new header is what session-only writes are now held to.
	h.mustStatus(h.do(http.MethodPut, "/api/manifest", strings.NewReader(setupManifest), "If-Match", h.manifestETag()), http.StatusForbidden)
	h.mustStatus(h.do(http.MethodPut, "/api/manifest", strings.NewReader(strings.Replace(rotated, `"v2"`, `"v3"`, 1)), "If-Match", h.manifestETag()), http.StatusOK)
}

// rawRequest opens a connection to the server and writes a request whose
// body is incomplete, so that the handler is left waiting for the rest.
func (h *harness) rawRequest(method, path, body string, claimed int) net.Conn {
	h.t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(h.url, "http://"))
	if err != nil {
		h.t.Fatalf("dial: %v", err)
	}
	h.t.Cleanup(func() { _ = conn.Close() })
	_, err = fmt.Fprintf(conn, "%s %s HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s",
		method, path, strings.TrimPrefix(h.url, "http://"), claimed, body)
	if err != nil {
		h.t.Fatalf("write request: %v", err)
	}
	return conn
}

// readStatus reads the status line of the response on conn, within limit.
func readStatus(t *testing.T, conn net.Conn, limit time.Duration) int {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(limit))
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("no response within %s: %v", limit, err)
	}
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode
}

// A setup request that entered while the archive was empty and takes its
// time over the body must not replace the manifest of the setup that
// completed meanwhile.
func TestSetupCannotOverwriteAfterSetup(t *testing.T) {
	h := newHarness(t)
	body := `{"auth_key":` + quote(authKey(7)) + `,"recovery_auth_key":` + quote(authKey(8)) +
		`,"kdf":` + defaultKDF + `,"manifest":` + quote(b64(envelope("intruder"))) + `}`
	// Everything but the closing brace: the decoder has to wait.
	conn := h.rawRequest(http.MethodPost, "/api/setup", body[:len(body)-1], len(body))
	// Give the handler time to get past its first look at the credentials.
	time.Sleep(100 * time.Millisecond)

	h.mustStatus(h.setup(authKey(1), recoveryKey, defaultKDF), http.StatusCreated)

	if _, err := conn.Write([]byte("}")); err != nil {
		t.Fatalf("finish body: %v", err)
	}
	if status := readStatus(t, conn, 5*time.Second); status != http.StatusConflict {
		t.Fatalf("late setup = %d, want 409", status)
	}
	h.mustStatus(h.login(authKey(1)), http.StatusNoContent)
	if got := h.manifest(); got != setupManifest {
		t.Fatalf("manifest = %q, want the owner's %q", got, setupManifest)
	}
	h.mustStatus(h.newClient().login(authKey(7)), http.StatusUnauthorized)
}

// A request whose body never arrives is cut off, so it cannot hold its
// connection and goroutine open indefinitely.
func TestBodyTimeout(t *testing.T) {
	h := loggedIn(t, func(o *options) {
		o.cfg.BodyTimeout = 200 * time.Millisecond
		o.cfg.BlobTimeout = 200 * time.Millisecond
	})
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/login"},
		{http.MethodPut, "/api/blobs/" + blobID("a")},
	} {
		conn := h.rawRequest(tc.method, tc.path, "{", 100)
		start := time.Now()
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		// Either an error answer or a closed connection; a hang is the failure.
		if _, err := bufio.NewReader(conn).ReadByte(); err != nil && !strings.Contains(err.Error(), "EOF") && !strings.Contains(err.Error(), "reset") {
			t.Fatalf("%s %s: %v", tc.method, tc.path, err)
		}
		if waited := time.Since(start); waited > 3*time.Second {
			t.Fatalf("%s %s: the server waited %s for a body that never came", tc.method, tc.path, waited)
		}
	}
	// The server is still fine afterwards.
	h.mustStatus(h.do(http.MethodGet, "/api/blobs", nil), http.StatusOK)
}

// Behind a trusted proxy the rate limiter keys on the address the proxy
// reports; from anywhere else X-Forwarded-For is a lie waiting to happen.
func TestTrustedProxy(t *testing.T) {
	for _, trusted := range []bool{true, false} {
		t.Run(fmt.Sprintf("trusted=%v", trusted), func(t *testing.T) {
			h := newHarness(t, func(o *options) {
				o.limiter = auth.NewRateLimiter(1, time.Minute)
				if trusted {
					o.cfg.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("::1/128")}
				}
			})
			h.mustStatus(h.postJSON("/api/setup", `{"auth_key":`+quote(authKey(1))+`,"recovery_auth_key":`+quote(recoveryKey)+
				`,"kdf":`+defaultKDF+`,"manifest":`+quote(b64(setupManifest))+`}`, "X-Forwarded-For", "203.0.113.1"), http.StatusCreated)
			// Only the last address counts: the ones before it came from the client.
			second := h.postJSON("/api/login", `{"auth_key":`+quote(authKey(9))+`}`, "X-Forwarded-For", "203.0.113.1, 203.0.113.2")
			if trusted {
				h.mustStatus(second, http.StatusUnauthorized)
				h.mustStatus(h.postJSON("/api/login", `{"auth_key":`+quote(authKey(9))+`}`, "X-Forwarded-For", "203.0.113.2"), http.StatusTooManyRequests)
				h.mustStatus(h.postJSON("/api/login", `{"auth_key":`+quote(authKey(9))+`}`, "X-Forwarded-For", "203.0.113.2, 203.0.113.3"), http.StatusUnauthorized)
			} else {
				h.mustStatus(second, http.StatusTooManyRequests)
			}
		})
	}
}

// A rekey leaves no journal behind, whether it went through or was refused.
func TestRekeyLeavesNoJournal(t *testing.T) {
	h := loggedIn(t)
	journal := filepath.Join(h.dataDir, "auth.json.next")
	noJournal := func(after string) {
		t.Helper()
		if _, err := os.Stat(journal); !os.IsNotExist(err) {
			t.Errorf("journal present after %s: %v", after, err)
		}
	}
	etag := h.manifestETag()
	h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), authKey: authKey(11), manifest: b64(envelope("v1")), ifMatch: `"stale"`}), http.StatusPreconditionFailed)
	noJournal("a conflict")
	h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), authKey: authKey(11), manifest: b64(envelope("v1"))}), http.StatusPreconditionRequired)
	noJournal("a missing precondition")
	h.mustStatus(h.rekey(rekeyRequest{current: authKey(1), authKey: authKey(11), manifest: b64(envelope("v1")), ifMatch: etag}), http.StatusOK)
	noJournal("a rekey")

	// The credentials on disk are the rotated ones.
	creds, err := auth.LoadCredentials(filepath.Join(h.dataDir, "auth.json"))
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	if key, _ := auth.DecodeAuthKey(authKey(11)); !creds.Verify(key) {
		t.Error("the rotated key does not verify from disk")
	}
}
