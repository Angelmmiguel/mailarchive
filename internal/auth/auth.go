// Package auth holds the server side of mailarchive's authentication: the
// stored auth-key hashes, the client's KDF parameters, sessions and the login
// rate limiter.
//
// The server never sees the passphrase or any encryption key. The client
// derives an auth key from the passphrase with Argon2id and a dedicated salt,
// and a second one from its recovery key; those two are the only credentials
// it ever sends.
package auth

import (
	"bytes"
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

// MaxKDFBytes bounds the compacted KDF parameters the server will store and
// serve. They are a handful of integers and a salt; anything larger is not
// KDF parameters.
const MaxKDFBytes = 1024

// credentialsVersion is the schema version of the credentials file.
const credentialsVersion = 2

// rotationVersion is the schema version of the rotation journal.
const rotationVersion = 1

// Authentication errors. Callers match them with errors.Is.
var (
	// ErrAlreadySetup is returned by Setup when the archive already has
	// credentials. There is no server-side reset by design.
	ErrAlreadySetup = errors.New("auth: already set up")
	// ErrNotSetup is returned by Stage when the archive has no credentials
	// to rotate.
	ErrNotSetup = errors.New("auth: not set up")
	// ErrInvalidKey is returned when an auth key is malformed or of the wrong
	// length.
	ErrInvalidKey = errors.New("auth: invalid auth key")
	// ErrInvalidKDF is returned when the KDF parameters are not a JSON object
	// or exceed MaxKDFBytes once compacted.
	ErrInvalidKDF = errors.New("auth: invalid kdf parameters")
	// ErrNothingToRotate is returned by Stage when every argument is nil.
	ErrNothingToRotate = errors.New("auth: nothing to rotate")
)

// Credentials is the archive's stored account: the SHA-256 of the client's
// passphrase auth key and of its recovery auth key, plus the KDF parameters
// the client needs before it can log in, persisted as JSON.
//
// A slow password hash such as Argon2id would add nothing here. The recovery
// auth key derives from 256 random bits and cannot be guessed. The passphrase
// auth key carries only the passphrase's own entropy, but every guess at it
// already costs the client-side Argon2id run, and the wrapped DEK in the
// manifest can be tested at exactly that price; a second slow hash on the
// server would not raise it. What matters is that the keys themselves are
// never stored and that comparisons are constant time.
type Credentials struct {
	path string

	mu           sync.RWMutex
	hash         []byte // nil until the archive is set up
	recoveryHash []byte
	kdf          json.RawMessage // compacted; opaque to the server
}

type credentialsFile struct {
	Version             int             `json:"version"`
	AuthKeyHash         string          `json:"auth_key_hash"`
	RecoveryAuthKeyHash string          `json:"recovery_auth_key_hash"`
	KDF                 json.RawMessage `json:"kdf"`
}

// rotationFile is the journal of a rotation under way: the credentials to
// install, and the manifest ETag that says whether they should be.
type rotationFile struct {
	Version      int             `json:"version"`
	ManifestETag string          `json:"manifest_etag"`
	Credentials  credentialsFile `json:"credentials"`
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
	if c.hash, c.recoveryHash, c.kdf, err = f.decode(); err != nil {
		return nil, err
	}
	return c, nil
}

// decode validates a parsed credentials file and returns what it holds.
func (f credentialsFile) decode() (hash, recoveryHash []byte, kdf json.RawMessage, err error) {
	if f.Version != credentialsVersion {
		return nil, nil, nil, fmt.Errorf("auth: unsupported credentials version %d, want %d", f.Version, credentialsVersion)
	}
	hash, err = hex.DecodeString(f.AuthKeyHash)
	if err != nil || len(hash) != sha256.Size {
		return nil, nil, nil, errors.New("auth: credentials auth key hash is malformed")
	}
	recoveryHash, err = hex.DecodeString(f.RecoveryAuthKeyHash)
	if err != nil || len(recoveryHash) != sha256.Size {
		return nil, nil, nil, errors.New("auth: credentials recovery auth key hash is malformed")
	}
	kdf, err = compactKDF(f.KDF)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("auth: credentials: %w", err)
	}
	return hash, recoveryHash, kdf, nil
}

// IsSetup reports whether the archive has credentials.
func (c *Credentials) IsSetup() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.hash != nil
}

// Setup stores the hashes of both auth keys and the KDF parameters. It fails
// with ErrAlreadySetup if the archive already has credentials, ErrInvalidKey
// if either key is not AuthKeyLen bytes and ErrInvalidKDF if kdf does not
// pass ValidateKDF.
func (c *Credentials) Setup(authKey, recoveryAuthKey []byte, kdf json.RawMessage) error {
	if len(authKey) != AuthKeyLen || len(recoveryAuthKey) != AuthKeyLen {
		return ErrInvalidKey
	}
	kdf, err := compactKDF(kdf)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.hash != nil {
		return ErrAlreadySetup
	}

	sum := sha256.Sum256(authKey)
	recoverySum := sha256.Sum256(recoveryAuthKey)
	if err := write(c.path, encode(sum[:], recoverySum[:], kdf), false); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return ErrAlreadySetup
		}
		return err
	}
	c.hash, c.recoveryHash, c.kdf = sum[:], recoverySum[:], kdf
	return nil
}

// Rotation is a change of credentials written to a journal but not yet in
// force. A rotation goes with a new manifest, stored elsewhere by the caller,
// and a crash between the two must not leave credentials that log in next
// to a manifest they cannot open. The journal therefore names the ETag the
// manifest will have once it is replaced; RecoverRotation compares that
// with the manifest on disk at the next start and either finishes the
// rotation or forgets it, so a crash at any point resolves to one
// consistent state.
//
// The sequence is Stage, the manifest write, then Commit; a manifest write
// that is refused is followed by Discard instead.
type Rotation struct {
	c            *Credentials
	hash         []byte
	recoveryHash []byte
	kdf          json.RawMessage
}

// Stage validates the replacement credentials and writes them to the journal,
// bound to manifestETag, the ETag of the manifest the caller is about to
// store. A nil argument keeps the current value; at least one must be
// non-nil or Stage fails with ErrNothingToRotate. It fails with ErrNotSetup
// when the archive has no credentials yet, and with ErrInvalidKey or
// ErrInvalidKDF exactly as Setup does. The credentials in force do not
// change until Commit.
func (c *Credentials) Stage(authKey, recoveryAuthKey []byte, kdf json.RawMessage, manifestETag string) (*Rotation, error) {
	if authKey == nil && recoveryAuthKey == nil && kdf == nil {
		return nil, ErrNothingToRotate
	}
	if (authKey != nil && len(authKey) != AuthKeyLen) ||
		(recoveryAuthKey != nil && len(recoveryAuthKey) != AuthKeyLen) {
		return nil, ErrInvalidKey
	}
	if kdf != nil {
		var err error
		if kdf, err = compactKDF(kdf); err != nil {
			return nil, err
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.hash == nil {
		return nil, ErrNotSetup
	}

	r := &Rotation{c: c, hash: c.hash, recoveryHash: c.recoveryHash, kdf: c.kdf}
	if authKey != nil {
		sum := sha256.Sum256(authKey)
		r.hash = sum[:]
	}
	if recoveryAuthKey != nil {
		sum := sha256.Sum256(recoveryAuthKey)
		r.recoveryHash = sum[:]
	}
	if kdf != nil {
		r.kdf = kdf
	}
	journal, err := json.Marshal(rotationFile{
		Version:      rotationVersion,
		ManifestETag: manifestETag,
		Credentials:  encodeFile(r.hash, r.recoveryHash, r.kdf),
	})
	if err != nil {
		panic("auth: encode rotation: " + err.Error())
	}
	if err := write(c.journalPath(), journal, true); err != nil {
		return nil, err
	}
	return r, nil
}

// Commit puts the staged credentials in force, the manifest the journal
// names being stored: the in-memory credentials change, then the file is
// replaced atomically and the journal removed. A failure to persist is
// returned, but the new credentials stay in force, because the journal
// already makes them durable: RecoverRotation installs them at the next
// start, the manifest being in place.
func (r *Rotation) Commit() error {
	c := r.c
	c.mu.Lock()
	defer c.mu.Unlock()
	c.hash, c.recoveryHash, c.kdf = r.hash, r.recoveryHash, r.kdf
	return c.install(r.hash, r.recoveryHash, r.kdf)
}

// Discard removes the journal, leaving the current credentials in force. It
// is for a rotation whose manifest write was refused.
func (r *Rotation) Discard() error {
	r.c.mu.Lock()
	defer r.c.mu.Unlock()
	return r.c.removeJournal()
}

// RecoverRotation resolves a rotation that a crash interrupted. It reads
// the journal, if there is one, and compares the manifest ETag it names with
// manifestETag, that of the manifest on disk (empty when there is none).
// Equal means the manifest was replaced and the staged credentials belong
// with it, so they are installed; different means the manifest write never
// happened, so the journal is dropped and the credentials on file stand. It
// reports whether credentials were installed.
func (c *Credentials) RecoverRotation(manifestETag string) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	data, err := os.ReadFile(c.journalPath())
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("auth: read rotation journal: %w", err)
	}
	var f rotationFile
	if err := json.Unmarshal(data, &f); err != nil {
		return false, fmt.Errorf("auth: parse rotation journal: %w", err)
	}
	if f.Version != rotationVersion {
		return false, fmt.Errorf("auth: unsupported rotation journal version %d, want %d", f.Version, rotationVersion)
	}
	if manifestETag == "" || f.ManifestETag != manifestETag {
		return false, c.removeJournal()
	}
	hash, recoveryHash, kdf, err := f.Credentials.decode()
	if err != nil {
		return false, fmt.Errorf("auth: rotation journal: %w", err)
	}
	if err := c.install(hash, recoveryHash, kdf); err != nil {
		return false, err
	}
	c.hash, c.recoveryHash, c.kdf = hash, recoveryHash, kdf
	return true, nil
}

// install replaces the credentials file and removes the journal. The caller
// holds the lock.
func (c *Credentials) install(hash, recoveryHash []byte, kdf json.RawMessage) error {
	if err := write(c.path, encode(hash, recoveryHash, kdf), true); err != nil {
		return err
	}
	return c.removeJournal()
}

// removeJournal deletes the journal if there is one. The caller holds the
// lock. The directory is not synced afterwards: a removal lost to a crash
// is resolved again by RecoverRotation, to the same outcome.
func (c *Credentials) removeJournal() error {
	if err := os.Remove(c.journalPath()); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("auth: remove rotation journal: %w", err)
	}
	return nil
}

// journalPath is where a staged rotation waits, next to the credentials.
func (c *Credentials) journalPath() string { return c.path + ".next" }

// Verify reports whether authKey matches either stored credential. Both
// hashes are always compared and the results combined, so timing reveals
// neither which credential was tried nor which one nearly matched.
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
	primary := subtle.ConstantTimeCompare(sum[:], c.hash)
	recovery := subtle.ConstantTimeCompare(sum[:], c.recoveryHash)
	return (primary | recovery) == 1
}

// KDF returns a copy of the stored KDF parameters, or nil when the archive is
// not set up.
func (c *Credentials) KDF() json.RawMessage {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.kdf == nil {
		return nil
	}
	return bytes.Clone(c.kdf)
}

// ValidateKDF reports whether kdf is acceptable as stored KDF parameters: a
// JSON object of at most MaxKDFBytes once compacted. The server does not
// interpret the contents; the client owns their meaning.
func ValidateKDF(kdf json.RawMessage) error {
	_, err := compactKDF(kdf)
	return err
}

// compactKDF validates kdf and returns its compacted form, the one that is
// stored and served.
func compactKDF(kdf json.RawMessage) (json.RawMessage, error) {
	trimmed := bytes.TrimLeft(kdf, " \t\r\n")
	if len(trimmed) == 0 || trimmed[0] != '{' || !json.Valid(kdf) {
		return nil, ErrInvalidKDF
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, kdf); err != nil {
		return nil, ErrInvalidKDF
	}
	if buf.Len() > MaxKDFBytes {
		return nil, ErrInvalidKDF
	}
	return buf.Bytes(), nil
}

// encodeFile builds the credentials file record.
func encodeFile(hash, recoveryHash []byte, kdf json.RawMessage) credentialsFile {
	return credentialsFile{
		Version:             credentialsVersion,
		AuthKeyHash:         hex.EncodeToString(hash),
		RecoveryAuthKeyHash: hex.EncodeToString(recoveryHash),
		KDF:                 kdf,
	}
}

// encode serialises a credentials file. Marshalling cannot fail: the hashes
// become hex strings and kdf has already been validated as JSON.
func encode(hash, recoveryHash []byte, kdf json.RawMessage) []byte {
	data, err := json.Marshal(encodeFile(hash, recoveryHash, kdf))
	if err != nil {
		panic("auth: encode credentials: " + err.Error())
	}
	return data
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

// write atomically writes data to path with mode 0600, via a temp file in the
// same directory that is fsynced before it is installed. With replace false
// an existing file fails with an error wrapping fs.ErrExist; with replace
// true it is renamed over.
func write(path string, data []byte, replace bool) (err error) {
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

	if replace {
		if err = os.Rename(f.Name(), path); err != nil {
			return fmt.Errorf("auth: replace %s: %w", filepath.Base(path), err)
		}
	} else {
		// link(2) refuses to overwrite, so credentials can never be replaced
		// by a second Setup, even from another process sharing the data dir.
		err = os.Link(f.Name(), path)
		_ = os.Remove(f.Name())
		if err != nil {
			return fmt.Errorf("auth: link %s: %w", filepath.Base(path), err)
		}
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
