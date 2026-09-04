package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// dirPerm keeps the archive private to its owner; os.CreateTemp already makes
// the files themselves 0600.
const dirPerm fs.FileMode = 0o700

// FS is a Store backed by a directory on disk. The layout is
//
//	blobs/<id[:2]>/<id>   one file per blob
//	manifest              the current manifest
//	tmp/                  in-progress writes, same filesystem as the targets
//
// so a backup is a plain recursive copy.
type FS struct {
	root string

	// manifestMu makes the read-compare-write of PutManifest atomic. The
	// manifest is the only mutable object in the store.
	manifestMu sync.Mutex
}

var _ Store = (*FS)(nil)

// NewFS prepares root and returns a Store rooted at it. Directories are created
// with 0700 and files with 0600: the archive is single-user and the data dir
// may sit on a shared NAS volume.
func NewFS(root string) (*FS, error) {
	s := &FS{root: root}
	for _, dir := range []string{root, filepath.Join(root, "blobs"), s.tmpDir()} {
		if err := os.MkdirAll(dir, dirPerm); err != nil {
			return nil, fmt.Errorf("store: create %s: %w", dir, err)
		}
	}
	// Temp files only ever survive a crash mid-write; they are never linked to
	// by anything, so dropping them at startup is safe.
	entries, err := os.ReadDir(s.tmpDir())
	if err != nil {
		return nil, fmt.Errorf("store: read temp dir: %w", err)
	}
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(s.tmpDir(), e.Name())); err != nil {
			return nil, fmt.Errorf("store: clean temp dir: %w", err)
		}
	}
	return s, nil
}

func (s *FS) tmpDir() string       { return filepath.Join(s.root, "tmp") }
func (s *FS) manifestPath() string { return filepath.Join(s.root, "manifest") }

// blobPath returns the on-disk path of id. It must only be called with an id
// that ValidID accepted.
func (s *FS) blobPath(id string) string {
	return filepath.Join(s.root, "blobs", id[:2], id)
}

// Get implements Store.
func (s *FS) Get(_ context.Context, id string) (io.ReadCloser, int64, error) {
	if !ValidID(id) {
		return nil, 0, ErrInvalidID
	}
	f, err := os.Open(s.blobPath(id))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, 0, ErrNotFound
		}
		return nil, 0, fmt.Errorf("store: open blob: %w", err)
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, 0, fmt.Errorf("store: stat blob: %w", err)
	}
	return f, info.Size(), nil
}

// Put implements Store.
func (s *FS) Put(ctx context.Context, id string, r io.Reader) error {
	if !ValidID(id) {
		return ErrInvalidID
	}
	final := s.blobPath(id)
	// Cheap early exit so a re-upload of a known blob does not stream its body
	// to disk first. The link below is the authoritative check.
	if _, err := os.Stat(final); err == nil {
		return ErrExists
	}
	if err := os.MkdirAll(filepath.Dir(final), dirPerm); err != nil {
		return fmt.Errorf("store: create shard dir: %w", err)
	}
	tmp, err := s.writeTemp(ctx, r)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp) }()

	// link(2) fails with EEXIST if the target exists, which makes the
	// write-once guarantee hold even against a concurrent Put of the same id.
	// A rename would silently overwrite.
	if err := os.Link(tmp, final); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return ErrExists
		}
		return fmt.Errorf("store: link blob: %w", err)
	}
	return syncDir(filepath.Dir(final))
}

// Exists implements Store.
func (s *FS) Exists(_ context.Context, id string) (bool, error) {
	if !ValidID(id) {
		return false, ErrInvalidID
	}
	_, err := os.Stat(s.blobPath(id))
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, fs.ErrNotExist):
		return false, nil
	default:
		return false, fmt.Errorf("store: stat blob: %w", err)
	}
}

// List implements Store.
func (s *FS) List(ctx context.Context, fn func(id string) error) error {
	blobs := filepath.Join(s.root, "blobs")
	shards, err := os.ReadDir(blobs)
	if err != nil {
		return fmt.Errorf("store: read blobs dir: %w", err)
	}
	for _, shard := range shards {
		if !shard.IsDir() {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(blobs, shard.Name()))
		if err != nil {
			return fmt.Errorf("store: read shard %s: %w", shard.Name(), err)
		}
		for _, e := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			// Anything that is not a well-formed id was not written by us.
			if e.IsDir() || !ValidID(e.Name()) {
				continue
			}
			if err := fn(e.Name()); err != nil {
				return err
			}
		}
	}
	return nil
}

// Manifest implements Store.
func (s *FS) Manifest(_ context.Context) ([]byte, string, error) {
	s.manifestMu.Lock()
	defer s.manifestMu.Unlock()

	data, err := os.ReadFile(s.manifestPath())
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, "", ErrNotFound
		}
		return nil, "", fmt.Errorf("store: read manifest: %w", err)
	}
	return data, etag(data), nil
}

// PutManifest implements Store.
func (s *FS) PutManifest(ctx context.Context, data []byte, ifMatch string) (string, error) {
	s.manifestMu.Lock()
	defer s.manifestMu.Unlock()

	current, err := os.ReadFile(s.manifestPath())
	switch {
	case err == nil:
		if ifMatch == "" {
			return "", ErrIfMatchRequired
		}
		if ifMatch != etag(current) {
			return "", ErrManifestConflict
		}
	case errors.Is(err, fs.ErrNotExist):
		// An ETag on a manifest that does not exist can only come from a client
		// working off a manifest that is gone; refuse rather than create one.
		if ifMatch != "" {
			return "", ErrManifestConflict
		}
	default:
		return "", fmt.Errorf("store: read manifest: %w", err)
	}

	tmp, err := s.writeTemp(ctx, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	defer func() { _ = os.Remove(tmp) }()

	if err := os.Rename(tmp, s.manifestPath()); err != nil {
		return "", fmt.Errorf("store: rename manifest: %w", err)
	}
	if err := syncDir(s.root); err != nil {
		return "", err
	}
	return etag(data), nil
}

// writeTemp streams r into a fresh file in tmp/ and returns its path. The file
// is fsynced and closed on success; on any error nothing is left behind.
func (s *FS) writeTemp(ctx context.Context, r io.Reader) (path string, err error) {
	f, err := os.CreateTemp(s.tmpDir(), "w-")
	if err != nil {
		return "", fmt.Errorf("store: create temp file: %w", err)
	}
	defer func() {
		if err != nil {
			_ = f.Close()
			_ = os.Remove(f.Name())
		}
	}()
	if _, err = io.Copy(f, &ctxReader{ctx: ctx, r: r}); err != nil {
		return "", fmt.Errorf("store: write temp file: %w", err)
	}
	// fsync before the link/rename so a crash cannot expose a final path whose
	// contents are still in the page cache.
	if err = f.Sync(); err != nil {
		return "", fmt.Errorf("store: sync temp file: %w", err)
	}
	if err = f.Close(); err != nil {
		return "", fmt.Errorf("store: close temp file: %w", err)
	}
	return f.Name(), nil
}

// syncDir fsyncs a directory so a rename or link that landed in it survives a
// power loss.
func syncDir(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("store: open dir: %w", err)
	}
	defer func() { _ = d.Close() }()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("store: sync dir: %w", err)
	}
	return nil
}

// etag returns the HTTP entity tag of data: the quoted hex SHA-256 of the bytes.
func etag(data []byte) string {
	sum := sha256.Sum256(data)
	return `"` + hex.EncodeToString(sum[:]) + `"`
}

// ctxReader aborts a copy when the request context is cancelled, so a client
// that disconnects mid-upload does not keep the server writing.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c *ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}
