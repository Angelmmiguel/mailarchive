// Package store defines the storage contract for the mailarchive server: an
// append-only set of opaque encrypted blobs plus one mutable, ETag-versioned
// manifest. The server never inspects the contents of either.
package store

import (
	"context"
	"errors"
	"io"
)

// Storage errors. Callers match them with errors.Is.
var (
	// ErrNotFound is returned when a blob or the manifest does not exist.
	ErrNotFound = errors.New("store: not found")
	// ErrExists is returned by Put when the id is already stored. Blobs are
	// write-once.
	ErrExists = errors.New("store: already exists")
	// ErrInvalidID is returned when an id is not a well-formed blob id.
	ErrInvalidID = errors.New("store: invalid id")
	// ErrManifestConflict is returned by PutManifest when the supplied ETag
	// does not match the stored manifest.
	ErrManifestConflict = errors.New("store: manifest conflict")
	// ErrIfMatchRequired is returned by PutManifest when a manifest exists but
	// the caller supplied no ETag to compare against.
	ErrIfMatchRequired = errors.New("store: if-match required")
	// ErrLocked is returned by NewFS when another process holds the data
	// directory.
	ErrLocked = errors.New("store: data dir is locked by another process")
)

// IDLen is the exact length of a blob id in characters.
const IDLen = 64

// ValidID reports whether id is a well-formed blob id: exactly IDLen lowercase
// hexadecimal characters, the encoding of an HMAC-SHA256 digest.
//
// Every id is checked with ValidID before it is used to build a path. This is
// the path-traversal boundary of the server: separators, dots, uppercase and
// NUL bytes are all rejected here, so no id that reaches the filesystem can
// escape the blob directory.
func ValidID(id string) bool {
	if len(id) != IDLen {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// Store is the blob and manifest storage used by the server.
type Store interface {
	// Get opens the blob with the given id. The caller closes the reader.
	Get(ctx context.Context, id string) (io.ReadCloser, int64, error)
	// Put stores a new blob. Blobs are write-once: if id is already stored,
	// Put returns ErrExists without consuming the rest of r.
	Put(ctx context.Context, id string, r io.Reader) error
	// Exists reports whether a blob with the given id is stored.
	Exists(ctx context.Context, id string) (bool, error)
	// List calls fn for every stored blob id and stops on the first error fn
	// returns, which it returns to the caller.
	List(ctx context.Context, fn func(id string) error) error
	// Manifest returns the manifest bytes and its ETag, or ErrNotFound.
	Manifest(ctx context.Context) (data []byte, etag string, err error)
	// PutManifest replaces the manifest. ifMatch must be the ETag of the
	// stored manifest; it may only be empty when no manifest exists yet.
	PutManifest(ctx context.Context, data []byte, ifMatch string) (etag string, err error)
}
