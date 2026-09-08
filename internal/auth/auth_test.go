package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testKDF = `{"name": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": "AAAA"}`

// compactKDF is testKDF as the server stores and serves it.
const compactTestKDF = `{"name":"argon2id","m":65536,"t":3,"p":1,"salt":"AAAA"}`

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

// setupCredentials returns credentials set up with testKey(1), testKey(2) and
// testKDF.
func setupCredentials(t *testing.T) (*Credentials, string) {
	t.Helper()
	c, path := newCredentials(t)
	if err := c.Setup(testKey(1), testKey(2), json.RawMessage(testKDF)); err != nil {
		t.Fatalf("Setup: %v", err)
	}
	return c, path
}

func readFile(t *testing.T, path string) credentialsFile {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read credentials: %v", err)
	}
	var file credentialsFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("parse credentials: %v", err)
	}
	return file
}

func hashOf(key []byte) string {
	sum := sha256.Sum256(key)
	return hex.EncodeToString(sum[:])
}

func TestSetupAndVerify(t *testing.T) {
	c, path := newCredentials(t)
	if c.IsSetup() {
		t.Fatal("fresh credentials report as set up")
	}
	if c.Verify(testKey(1)) {
		t.Fatal("Verify succeeded before setup")
	}
	if c.KDF() != nil {
		t.Fatal("KDF is not nil before setup")
	}

	if err := c.Setup(testKey(1), testKey(2), json.RawMessage(testKDF)); err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if !c.IsSetup() {
		t.Fatal("credentials do not report as set up")
	}
	if !c.Verify(testKey(1)) {
		t.Error("Verify rejected the passphrase key")
	}
	if !c.Verify(testKey(2)) {
		t.Error("Verify rejected the recovery key")
	}
	if c.Verify(testKey(3)) {
		t.Error("Verify accepted a third key")
	}
	if c.Verify(testKey(1)[:16]) {
		t.Error("Verify accepted a short key")
	}
	if c.Verify(nil) {
		t.Error("Verify accepted an empty key")
	}
	if got := string(c.KDF()); got != compactTestKDF {
		t.Errorf("KDF = %s, want %s", got, compactTestKDF)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat credentials: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("credentials mode = %o, want 600", perm)
	}

	// The file stores the hashes, never the keys themselves, and the kdf as
	// compacted.
	file := readFile(t, path)
	if file.Version != credentialsVersion {
		t.Errorf("version = %d, want %d", file.Version, credentialsVersion)
	}
	if file.AuthKeyHash != hashOf(testKey(1)) || file.RecoveryAuthKeyHash != hashOf(testKey(2)) {
		t.Errorf("credentials file = %+v, want both key hashes", file)
	}
	if string(file.KDF) != compactTestKDF {
		t.Errorf("stored kdf = %s, want %s", file.KDF, compactTestKDF)
	}
}

func TestKDFCopy(t *testing.T) {
	c, _ := setupCredentials(t)
	kdf := c.KDF()
	kdf[0] = 'x'
	if got := string(c.KDF()); got != compactTestKDF {
		t.Errorf("KDF after mutating a copy = %s, want %s", got, compactTestKDF)
	}
}

func TestSetupTwice(t *testing.T) {
	c, _ := setupCredentials(t)
	if err := c.Setup(testKey(3), testKey(4), json.RawMessage(testKDF)); !errors.Is(err, ErrAlreadySetup) {
		t.Fatalf("second Setup = %v, want ErrAlreadySetup", err)
	}
	if !c.Verify(testKey(1)) || !c.Verify(testKey(2)) {
		t.Error("the original keys stopped working")
	}
}

func TestSetupRefusesAnExistingFile(t *testing.T) {
	// A second process, or a stale file the loader never saw, must not be
	// silently overwritten.
	c, path := newCredentials(t)
	if err := os.WriteFile(path, []byte(`{"version":2}`), 0o600); err != nil {
		t.Fatalf("write credentials: %v", err)
	}
	if err := c.Setup(testKey(1), testKey(2), json.RawMessage(testKDF)); !errors.Is(err, ErrAlreadySetup) {
		t.Fatalf("Setup = %v, want ErrAlreadySetup", err)
	}
}

func TestSetupRejectsBadKeyLength(t *testing.T) {
	c, path := newCredentials(t)
	for _, key := range [][]byte{nil, testKey(1)[:31], append(testKey(1), 0)} {
		if err := c.Setup(key, testKey(2), json.RawMessage(testKDF)); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("Setup(auth key of %d bytes) = %v, want ErrInvalidKey", len(key), err)
		}
		if err := c.Setup(testKey(1), key, json.RawMessage(testKDF)); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("Setup(recovery key of %d bytes) = %v, want ErrInvalidKey", len(key), err)
		}
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Error("a rejected key created a credentials file")
	}
}

func badKDFs() map[string]string {
	return map[string]string{
		"nil":          "",
		"string":       `"argon2id"`,
		"number":       `42`,
		"null":         `null`,
		"array":        `[{"name":"argon2id"}]`,
		"invalid json": `{"name":`,
		"trailing":     `{"name":"argon2id"} x`,
		"too large":    `{"salt":"` + strings.Repeat("A", MaxKDFBytes) + `"}`,
	}
}

func TestSetupRejectsBadKDF(t *testing.T) {
	c, path := newCredentials(t)
	for name, kdf := range badKDFs() {
		if err := c.Setup(testKey(1), testKey(2), json.RawMessage(kdf)); !errors.Is(err, ErrInvalidKDF) {
			t.Errorf("Setup(%s kdf) = %v, want ErrInvalidKDF", name, err)
		}
		if err := ValidateKDF(json.RawMessage(kdf)); !errors.Is(err, ErrInvalidKDF) {
			t.Errorf("ValidateKDF(%s) = %v, want ErrInvalidKDF", name, err)
		}
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Error("a rejected kdf created a credentials file")
	}

	// Whitespace does not count against the limit: the compacted form does.
	padded := `{ "salt" : "` + strings.Repeat("A", MaxKDFBytes-len(`{"salt":""}`)) + `" }`
	if err := ValidateKDF(json.RawMessage(padded)); err != nil {
		t.Errorf("ValidateKDF(padded object at the limit) = %v", err)
	}
	if err := ValidateKDF(json.RawMessage("  \n" + testKDF)); err != nil {
		t.Errorf("ValidateKDF(leading whitespace) = %v", err)
	}
}

func TestStageAndCommit(t *testing.T) {
	newKDF := `{"name":"argon2id","m":262144,"t":4,"p":2,"salt":"BBBB"}`
	for name, tc := range map[string]struct {
		authKey, recoveryKey []byte
		kdf                  string
	}{
		"auth key":     {authKey: testKey(11)},
		"recovery key": {recoveryKey: testKey(12)},
		"kdf":          {kdf: newKDF},
		"all":          {authKey: testKey(11), recoveryKey: testKey(12), kdf: newKDF},
	} {
		t.Run(name, func(t *testing.T) {
			c, path := setupCredentials(t)
			var kdf json.RawMessage
			if tc.kdf != "" {
				kdf = json.RawMessage(tc.kdf)
			}
			r, err := c.Stage(tc.authKey, tc.recoveryKey, kdf, `"new"`)
			if err != nil {
				t.Fatalf("Stage: %v", err)
			}
			// Staged is not in force: the old keys still verify, the new do not.
			if !c.Verify(testKey(1)) || !c.Verify(testKey(2)) || c.Verify(testKey(11)) || c.Verify(testKey(12)) {
				t.Fatal("Stage changed the credentials in force")
			}
			if _, err := os.Stat(path + ".next"); err != nil {
				t.Fatalf("no journal after Stage: %v", err)
			}
			if err := r.Commit(); err != nil {
				t.Fatalf("Commit: %v", err)
			}
			if _, err := os.Stat(path + ".next"); !errors.Is(err, os.ErrNotExist) {
				t.Errorf("journal after Commit: %v", err)
			}

			wantAuth, wantRecovery, wantKDF := testKey(1), testKey(2), compactTestKDF
			if tc.authKey != nil {
				wantAuth = tc.authKey
			}
			if tc.recoveryKey != nil {
				wantRecovery = tc.recoveryKey
			}
			if tc.kdf != "" {
				wantKDF = tc.kdf
			}
			reloaded, err := LoadCredentials(path)
			if err != nil {
				t.Fatalf("LoadCredentials: %v", err)
			}
			for who, creds := range map[string]*Credentials{"in memory": c, "reloaded": reloaded} {
				if !creds.Verify(wantAuth) || !creds.Verify(wantRecovery) {
					t.Errorf("%s: the current keys do not verify", who)
				}
				if tc.authKey != nil && creds.Verify(testKey(1)) {
					t.Errorf("%s: the old auth key still verifies", who)
				}
				if tc.recoveryKey != nil && creds.Verify(testKey(2)) {
					t.Errorf("%s: the old recovery key still verifies", who)
				}
				if got := string(creds.KDF()); got != wantKDF {
					t.Errorf("%s: KDF = %s, want %s", who, got, wantKDF)
				}
			}
			if perm := mode(t, path); perm != 0o600 {
				t.Errorf("credentials mode after Commit = %o, want 600", perm)
			}
		})
	}
}

func mode(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	return info.Mode().Perm()
}

func TestDiscard(t *testing.T) {
	c, path := setupCredentials(t)
	r, err := c.Stage(testKey(11), testKey(12), nil, `"new"`)
	if err != nil {
		t.Fatalf("Stage: %v", err)
	}
	if err := r.Discard(); err != nil {
		t.Fatalf("Discard: %v", err)
	}
	if _, err := os.Stat(path + ".next"); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("journal after Discard: %v", err)
	}
	if !c.Verify(testKey(1)) || !c.Verify(testKey(2)) || c.Verify(testKey(11)) {
		t.Error("Discard changed the credentials in force")
	}
	if installed, err := c.RecoverRotation(`"new"`); err != nil || installed {
		t.Errorf("RecoverRotation after Discard = %v, %v; want false, nil", installed, err)
	}
}

// A crash between the manifest write and Commit leaves the journal next to
// the new manifest: the next start installs the staged credentials. A crash
// before the manifest write leaves it next to the old one: the journal goes.
func TestRecoverRotation(t *testing.T) {
	for name, tc := range map[string]struct {
		manifestETag string
		installed    bool
	}{
		"manifest replaced":  {manifestETag: `"new"`, installed: true},
		"manifest unchanged": {manifestETag: `"old"`, installed: false},
		"manifest gone":      {manifestETag: "", installed: false},
	} {
		t.Run(name, func(t *testing.T) {
			c, path := setupCredentials(t)
			if _, err := c.Stage(testKey(11), nil, nil, `"new"`); err != nil {
				t.Fatalf("Stage: %v", err)
			}
			// The process restarts: only the files survive.
			c, err := LoadCredentials(path)
			if err != nil {
				t.Fatalf("LoadCredentials: %v", err)
			}
			installed, err := c.RecoverRotation(tc.manifestETag)
			if err != nil {
				t.Fatalf("RecoverRotation: %v", err)
			}
			if installed != tc.installed {
				t.Fatalf("installed = %v, want %v", installed, tc.installed)
			}
			if _, err := os.Stat(path + ".next"); !errors.Is(err, os.ErrNotExist) {
				t.Errorf("journal after RecoverRotation: %v", err)
			}
			reloaded, err := LoadCredentials(path)
			if err != nil {
				t.Fatalf("LoadCredentials: %v", err)
			}
			for who, creds := range map[string]*Credentials{"in memory": c, "reloaded": reloaded} {
				if creds.Verify(testKey(11)) != tc.installed || creds.Verify(testKey(1)) == tc.installed {
					t.Errorf("%s: staged key verifies = %v, want %v", who, creds.Verify(testKey(11)), tc.installed)
				}
				if !creds.Verify(testKey(2)) {
					t.Errorf("%s: the untouched recovery key no longer verifies", who)
				}
			}
			// A second start finds nothing to do.
			if installed, err := c.RecoverRotation(tc.manifestETag); err != nil || installed {
				t.Errorf("second RecoverRotation = %v, %v; want false, nil", installed, err)
			}
		})
	}
}

func TestRecoverRotationRejectsBadJournal(t *testing.T) {
	c, path := setupCredentials(t)
	for name, journal := range map[string]string{
		"not json":    "nonsense",
		"bad version": `{"version":9,"manifest_etag":"x","credentials":{}}`,
		"bad hash":    `{"version":1,"manifest_etag":"\"m\"","credentials":{"version":2,"auth_key_hash":"zz","recovery_auth_key_hash":"zz","kdf":{}}}`,
	} {
		if err := os.WriteFile(path+".next", []byte(journal), 0o600); err != nil {
			t.Fatalf("write journal: %v", err)
		}
		if _, err := c.RecoverRotation(`"m"`); err == nil {
			t.Errorf("%s: RecoverRotation accepted the journal", name)
		}
		if !c.Verify(testKey(1)) || !c.Verify(testKey(2)) {
			t.Errorf("%s: a rejected journal changed the credentials", name)
		}
	}
}

func TestStageErrors(t *testing.T) {
	c, path := newCredentials(t)
	if _, err := c.Stage(testKey(11), nil, nil, `"m"`); !errors.Is(err, ErrNotSetup) {
		t.Fatalf("Stage before setup = %v, want ErrNotSetup", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Error("Stage before setup created a credentials file")
	}

	c, path = setupCredentials(t)
	if _, err := c.Stage(nil, nil, nil, `"m"`); !errors.Is(err, ErrNothingToRotate) {
		t.Errorf("Stage(nil, nil, nil) = %v, want ErrNothingToRotate", err)
	}
	if _, err := c.Stage(testKey(11)[:31], nil, nil, `"m"`); !errors.Is(err, ErrInvalidKey) {
		t.Errorf("Stage(short auth key) = %v, want ErrInvalidKey", err)
	}
	if _, err := c.Stage(nil, testKey(12)[:31], nil, `"m"`); !errors.Is(err, ErrInvalidKey) {
		t.Errorf("Stage(short recovery key) = %v, want ErrInvalidKey", err)
	}
	for name, kdf := range badKDFs() {
		if kdf == "" {
			continue // nil means keep
		}
		if _, err := c.Stage(nil, nil, json.RawMessage(kdf), `"m"`); !errors.Is(err, ErrInvalidKDF) {
			t.Errorf("Stage(%s kdf) = %v, want ErrInvalidKDF", name, err)
		}
	}

	// Nothing above touched the files or the in-memory state.
	if !c.Verify(testKey(1)) || !c.Verify(testKey(2)) || string(c.KDF()) != compactTestKDF {
		t.Error("a rejected Stage changed the in-memory credentials")
	}
	file := readFile(t, path)
	if file.AuthKeyHash != hashOf(testKey(1)) || file.RecoveryAuthKeyHash != hashOf(testKey(2)) || string(file.KDF) != compactTestKDF {
		t.Error("a rejected Stage changed the credentials file")
	}
	if _, err := os.Stat(path + ".next"); !errors.Is(err, os.ErrNotExist) {
		t.Error("a rejected Stage left a journal")
	}
}

func TestStageFailureKeepsOldCredentials(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	c, path := setupCredentials(t)
	dir := filepath.Dir(path)
	//nolint:gosec // The point is a directory the test cannot create files in;
	// the cleanup restores TempDir's own mode so it can be removed.
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) }) //nolint:gosec // see above

	_, err := c.Stage(testKey(11), testKey(12), json.RawMessage(`{"salt":"BBBB"}`), `"m"`)
	if err == nil {
		t.Fatal("Stage succeeded in an unwritable directory")
	}
	if errors.Is(err, ErrInvalidKey) || errors.Is(err, ErrInvalidKDF) || errors.Is(err, ErrNotSetup) {
		t.Fatalf("Stage = %v, want a filesystem error", err)
	}

	if !c.Verify(testKey(1)) || !c.Verify(testKey(2)) || c.Verify(testKey(11)) || c.Verify(testKey(12)) {
		t.Error("a failed Stage changed the in-memory keys")
	}
	if got := string(c.KDF()); got != compactTestKDF {
		t.Errorf("a failed Stage changed the in-memory kdf to %s", got)
	}
	file := readFile(t, path)
	if file.AuthKeyHash != hashOf(testKey(1)) || file.RecoveryAuthKeyHash != hashOf(testKey(2)) || string(file.KDF) != compactTestKDF {
		t.Error("a failed Stage changed the credentials file")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(entries) != 1 {
		t.Errorf("%d entries left in the data dir, want only auth.json", len(entries))
	}
}

// Once the journal is written and the manifest stored, the rotation is
// durable: a Commit whose file write fails still puts the new credentials
// in force, and the next start installs them from the journal.
func TestCommitPersistFailureKeepsNewCredentialsInForce(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	c, path := setupCredentials(t)
	r, err := c.Stage(testKey(11), nil, nil, `"new"`)
	if err != nil {
		t.Fatalf("Stage: %v", err)
	}
	dir := filepath.Dir(path)
	if err := os.Chmod(dir, 0o500); err != nil { //nolint:gosec // see TestStageFailureKeepsOldCredentials
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) }) //nolint:gosec // see above

	if err := r.Commit(); err == nil {
		t.Fatal("Commit succeeded in an unwritable directory")
	}
	if !c.Verify(testKey(11)) || c.Verify(testKey(1)) {
		t.Error("a Commit that could not persist did not put the new credentials in force")
	}

	if err := os.Chmod(dir, 0o700); err != nil { //nolint:gosec // see above
		t.Fatalf("chmod: %v", err)
	}
	restarted, err := LoadCredentials(path)
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	if installed, err := restarted.RecoverRotation(`"new"`); err != nil || !installed {
		t.Fatalf("RecoverRotation = %v, %v; want true, nil", installed, err)
	}
	if !restarted.Verify(testKey(11)) || restarted.Verify(testKey(1)) {
		t.Error("the restart did not install the staged credentials")
	}
}

func TestLoadCredentials(t *testing.T) {
	c, path := setupCredentials(t)
	r, err := c.Stage(testKey(3), nil, nil, `"m"`)
	if err != nil {
		t.Fatalf("Stage: %v", err)
	}
	if err := r.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	reloaded, err := LoadCredentials(path)
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	if !reloaded.IsSetup() || !reloaded.Verify(testKey(3)) || !reloaded.Verify(testKey(2)) {
		t.Error("reloaded credentials do not verify the keys")
	}
	if got := string(reloaded.KDF()); got != compactTestKDF {
		t.Errorf("reloaded KDF = %s, want %s", got, compactTestKDF)
	}

	good := hashOf(testKey(1))
	for name, content := range map[string]string{
		"not json":        "{",
		"bad version":     `{"version":99,"auth_key_hash":"` + good + `","recovery_auth_key_hash":"` + good + `","kdf":{}}`,
		"version 1":       `{"version":1,"auth_key_hash":"` + good + `"}`,
		"bad hash":        `{"version":2,"auth_key_hash":"zz","recovery_auth_key_hash":"` + good + `","kdf":{}}`,
		"short hash":      `{"version":2,"auth_key_hash":"abcd","recovery_auth_key_hash":"` + good + `","kdf":{}}`,
		"missing recover": `{"version":2,"auth_key_hash":"` + good + `","kdf":{}}`,
		"bad recovery":    `{"version":2,"auth_key_hash":"` + good + `","recovery_auth_key_hash":"abcd","kdf":{}}`,
		"missing kdf":     `{"version":2,"auth_key_hash":"` + good + `","recovery_auth_key_hash":"` + good + `"}`,
		"kdf array":       `{"version":2,"auth_key_hash":"` + good + `","recovery_auth_key_hash":"` + good + `","kdf":[]}`,
		"kdf too large":   `{"version":2,"auth_key_hash":"` + good + `","recovery_auth_key_hash":"` + good + `","kdf":{"s":"` + strings.Repeat("A", MaxKDFBytes) + `"}}`,
		"missing fields":  `{}`,
	} {
		bad := filepath.Join(t.TempDir(), "auth.json")
		if err := os.WriteFile(bad, []byte(content), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		_, err := LoadCredentials(bad)
		if err == nil {
			t.Errorf("LoadCredentials(%s) succeeded, want an error", name)
		}
		if name == "version 1" && !strings.Contains(err.Error(), "version 1") {
			t.Errorf("LoadCredentials(version 1) = %v, want the version in the message", err)
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
