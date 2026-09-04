// Package auth holds the server side of mailarchive's authentication: the
// stored auth-key hash, sessions and the login rate limiter.
//
// The server never sees the passphrase or any encryption key. The client
// derives an auth key from the passphrase with Argon2id and a dedicated salt,
// and that is the only credential it ever sends.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// AuthKeyLen is the required length in bytes of a decoded auth key.
const AuthKeyLen = 32

// credentialsVersion is the schema version of the credentials file.
const credentialsVersion = 1

// Authentication errors. Callers match them with errors.Is.
var (
	// ErrAlreadySetup is returned by Setup when the archive already has
	// credentials. There is no server-side reset by design.
	ErrAlreadySetup = errors.New("auth: already set up")
	// ErrInvalidKey is returned when an auth key is malformed or of the wrong
	// length.
	ErrInvalidKey = errors.New("auth: invalid auth key")
)

// Credentials is the archive's single stored credential: the SHA-256 of the
// client's auth key, persisted as JSON.
//
// A password hash such as Argon2id would add nothing here: the auth key is
// itself an Argon2id output with 256 bits of entropy, so it is not guessable
// from the digest. What matters is that the key itself is never stored and
// that comparisons are constant time.
type Credentials struct {
	path string

	mu   sync.RWMutex
	hash []byte // nil until the archive is set up
}

type credentialsFile struct {
	Version     int    `json:"version"`
	AuthKeyHash string `json:"auth_key_hash"`
}

// LoadCredentials reads the credentials file at path, or returns credentials
// that are not yet set up if the file does not exist.
func LoadCredentials(path string) (*Credentials, error) {
	c := &Credentials{path: path}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return c, nil
		}
		return nil, fmt.Errorf("auth: read credentials: %w", err)
	}
	var f credentialsFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("auth: parse credentials: %w", err)
	}
	if f.Version != credentialsVersion {
		return nil, fmt.Errorf("auth: unsupported credentials version %d", f.Version)
	}
	hash, err := hex.DecodeString(f.AuthKeyHash)
	if err != nil || len(hash) != sha256.Size {
		return nil, fmt.Errorf("auth: credentials hash is malformed")
	}
	c.hash = hash
	return c, nil
}

// IsSetup reports whether the archive has credentials.
func (c *Credentials) IsSetup() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.hash != nil
}

// Setup stores the hash of authKey. It fails with ErrAlreadySetup if the
// archive already has credentials.
func (c *Credentials) Setup(authKey []byte) error {
	if len(authKey) != AuthKeyLen {
		return ErrInvalidKey
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.hash != nil {
		return ErrAlreadySetup
	}

	sum := sha256.Sum256(authKey)
	data, err := json.Marshal(credentialsFile{
		Version:     credentialsVersion,
		AuthKeyHash: hex.EncodeToString(sum[:]),
	})
	if err != nil {
		return fmt.Errorf("auth: encode credentials: %w", err)
	}
	if err := writeNew(c.path, data); err != nil {
		return err
	}
	c.hash = sum[:]
	return nil
}

// Verify reports whether authKey matches the stored credentials. It is
// constant time with respect to the stored hash.
func (c *Credentials) Verify(authKey []byte) bool {
	if len(authKey) != AuthKeyLen {
		return false
	}
	sum := sha256.Sum256(authKey)

	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.hash == nil {
		return false
	}
	return subtle.ConstantTimeCompare(sum[:], c.hash) == 1
}

// DecodeAuthKey decodes a standard-base64 auth key as sent by the client and
// checks its length.
func DecodeAuthKey(s string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, ErrInvalidKey
	}
	if len(key) != AuthKeyLen {
		return nil, ErrInvalidKey
	}
	return key, nil
}

// randomToken returns 32 cryptographically random bytes, base64url encoded.
// crypto/rand.Read cannot fail; it panics if the system source is broken.
func randomToken() string {
	var b [32]byte
	_, _ = rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// writeNew atomically creates path with mode 0600 and fails with
// ErrAlreadySetup if it already exists.
func writeNew(path string, data []byte) (err error) {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".auth-")
	if err != nil {
		return fmt.Errorf("auth: create temp file: %w", err)
	}
	defer func() {
		if err != nil {
			_ = f.Close()
			_ = os.Remove(f.Name())
		}
	}()
	if _, err = f.Write(data); err != nil {
		return fmt.Errorf("auth: write temp file: %w", err)
	}
	if err = f.Sync(); err != nil {
		return fmt.Errorf("auth: sync temp file: %w", err)
	}
	if err = f.Close(); err != nil {
		return fmt.Errorf("auth: close temp file: %w", err)
	}

	// link(2) refuses to overwrite, so credentials can never be replaced by a
	// second Setup, even from another process sharing the data dir.
	err = os.Link(f.Name(), path)
	_ = os.Remove(f.Name())
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return ErrAlreadySetup
		}
		return fmt.Errorf("auth: link credentials: %w", err)
	}

	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("auth: open data dir: %w", err)
	}
	defer func() { _ = d.Close() }()
	if err = d.Sync(); err != nil {
		return fmt.Errorf("auth: sync data dir: %w", err)
	}
	return nil
}
