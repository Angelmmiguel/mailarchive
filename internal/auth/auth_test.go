package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func testKey(b byte) []byte {
	key := make([]byte, AuthKeyLen)
	for i := range key {
		key[i] = b
	}
	return key
}

func newCredentials(t *testing.T) (*Credentials, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "auth.json")
	c, err := LoadCredentials(path)
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	return c, path
}

func TestSetupAndVerify(t *testing.T) {
	c, path := newCredentials(t)
	if c.IsSetup() {
		t.Fatal("fresh credentials report as set up")
	}
	if c.Verify(testKey(1)) {
		t.Fatal("Verify succeeded before setup")
	}

	if err := c.Setup(testKey(1)); err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if !c.IsSetup() {
		t.Fatal("credentials do not report as set up")
	}
	if !c.Verify(testKey(1)) {
		t.Error("Verify rejected the right key")
	}
	if c.Verify(testKey(2)) {
		t.Error("Verify accepted the wrong key")
	}
	if c.Verify(testKey(1)[:16]) {
		t.Error("Verify accepted a short key")
	}
	if c.Verify(nil) {
		t.Error("Verify accepted an empty key")
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat credentials: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("credentials mode = %o, want 600", perm)
	}

	// The file stores the hash, never the key itself.
	var file credentialsFile
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read credentials: %v", err)
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("parse credentials: %v", err)
	}
	sum := sha256.Sum256(testKey(1))
	if file.Version != credentialsVersion || file.AuthKeyHash != hex.EncodeToString(sum[:]) {
		t.Errorf("credentials file = %+v, want version %d and the key hash", file, credentialsVersion)
	}
}

func TestSetupTwice(t *testing.T) {
	c, _ := newCredentials(t)
	if err := c.Setup(testKey(1)); err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if err := c.Setup(testKey(2)); !errors.Is(err, ErrAlreadySetup) {
		t.Fatalf("second Setup = %v, want ErrAlreadySetup", err)
	}
	if !c.Verify(testKey(1)) {
		t.Error("the original key stopped working")
	}
}

func TestSetupRefusesAnExistingFile(t *testing.T) {
	// A second process, or a stale file the loader never saw, must not be
	// silently overwritten.
	c, path := newCredentials(t)
	if err := os.WriteFile(path, []byte(`{"version":1,"auth_key_hash":"00"}`), 0o600); err != nil {
		t.Fatalf("write credentials: %v", err)
	}
	if err := c.Setup(testKey(1)); !errors.Is(err, ErrAlreadySetup) {
		t.Fatalf("Setup = %v, want ErrAlreadySetup", err)
	}
}

func TestSetupRejectsBadKeyLength(t *testing.T) {
	c, path := newCredentials(t)
	for _, key := range [][]byte{nil, testKey(1)[:31], append(testKey(1), 0)} {
		if err := c.Setup(key); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("Setup(%d bytes) = %v, want ErrInvalidKey", len(key), err)
		}
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Error("a rejected key created a credentials file")
	}
}

func TestLoadCredentials(t *testing.T) {
	c, path := newCredentials(t)
	if err := c.Setup(testKey(3)); err != nil {
		t.Fatalf("Setup: %v", err)
	}

	reloaded, err := LoadCredentials(path)
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	if !reloaded.IsSetup() || !reloaded.Verify(testKey(3)) {
		t.Error("reloaded credentials do not verify the key")
	}

	for name, content := range map[string]string{
		"not json":       "{",
		"bad version":    `{"version":99,"auth_key_hash":"00"}`,
		"bad hash":       `{"version":1,"auth_key_hash":"zz"}`,
		"short hash":     `{"version":1,"auth_key_hash":"abcd"}`,
		"missing fields": `{}`,
	} {
		bad := filepath.Join(t.TempDir(), "auth.json")
		if err := os.WriteFile(bad, []byte(content), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		if _, err := LoadCredentials(bad); err == nil {
			t.Errorf("LoadCredentials(%s) succeeded, want an error", name)
		}
	}
}

func TestDecodeAuthKey(t *testing.T) {
	key := testKey(7)
	got, err := DecodeAuthKey(base64.StdEncoding.EncodeToString(key))
	if err != nil {
		t.Fatalf("DecodeAuthKey: %v", err)
	}
	if string(got) != string(key) {
		t.Error("decoded key differs from the original")
	}

	for _, bad := range []string{
		"",
		"not base64!",
		base64.StdEncoding.EncodeToString(key[:16]),
		base64.StdEncoding.EncodeToString(append(key, 0)),
		base64.RawURLEncoding.EncodeToString(key),
	} {
		if _, err := DecodeAuthKey(bad); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("DecodeAuthKey(%q) = %v, want ErrInvalidKey", bad, err)
		}
	}
}
