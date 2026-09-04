package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func newStore(t *testing.T) (*FS, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := NewFS(dir)
	if err != nil {
		t.Fatalf("NewFS: %v", err)
	}
	return s, dir
}

// id builds a syntactically valid blob id from a seed character.
func id(c byte) string { return strings.Repeat(string(c), IDLen) }

func TestValidID(t *testing.T) {
	valid := []string{
		strings.Repeat("a", 64),
		strings.Repeat("0", 64),
		"0123456789abcdef" + strings.Repeat("f", 48),
	}
	for _, v := range valid {
		if !ValidID(v) {
			t.Errorf("ValidID(%q) = false, want true", v)
		}
	}

	invalid := []string{
		"",
		"..",
		"../" + strings.Repeat("a", 61),
		strings.Repeat("a", 63),
		strings.Repeat("a", 65),
		strings.Repeat("A", 64),
		strings.Repeat("a", 32) + "/" + strings.Repeat("a", 31),
		strings.Repeat("a", 63) + "\x00",
		strings.Repeat("a", 63) + "g",
		strings.Repeat("a", 63) + " ",
		strings.Repeat("a", 63) + ".",
		"\\" + strings.Repeat("a", 63),
	}
	for _, v := range invalid {
		if ValidID(v) {
			t.Errorf("ValidID(%q) = true, want false", v)
		}
	}
}

func TestPutGetRoundTrip(t *testing.T) {
	s, dir := newStore(t)
	ctx := t.Context()
	want := []byte("ciphertext")

	if err := s.Put(ctx, id('a'), bytes.NewReader(want)); err != nil {
		t.Fatalf("Put: %v", err)
	}
	rc, size, err := s.Get(ctx, id('a'))
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	defer func() { _ = rc.Close() }()
	if size != int64(len(want)) {
		t.Errorf("size = %d, want %d", size, len(want))
	}
	got, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("content = %q, want %q", got, want)
	}

	// Sharded layout, mode 0600.
	path := filepath.Join(dir, "blobs", "aa", id('a'))
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat blob: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("blob mode = %o, want 600", perm)
	}
}

func TestGetNotFound(t *testing.T) {
	s, _ := newStore(t)
	if _, _, err := s.Get(t.Context(), id('b')); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get missing = %v, want ErrNotFound", err)
	}
}

func TestPutIsWriteOnce(t *testing.T) {
	s, _ := newStore(t)
	ctx := t.Context()
	if err := s.Put(ctx, id('c'), strings.NewReader("first")); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := s.Put(ctx, id('c'), strings.NewReader("second")); !errors.Is(err, ErrExists) {
		t.Fatalf("second Put = %v, want ErrExists", err)
	}
	rc, _, err := s.Get(ctx, id('c'))
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	defer func() { _ = rc.Close() }()
	got, _ := io.ReadAll(rc)
	if string(got) != "first" {
		t.Errorf("content = %q, want %q", got, "first")
	}
}

func TestConcurrentPutSameID(t *testing.T) {
	s, _ := newStore(t)
	ctx := t.Context()

	const writers = 8
	var wg sync.WaitGroup
	results := make([]error, writers)
	for i := range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = s.Put(ctx, id('d'), strings.NewReader(fmt.Sprintf("body-%d", i)))
		}()
	}
	wg.Wait()

	winners := 0
	for i, err := range results {
		switch {
		case err == nil:
			winners++
		case errors.Is(err, ErrExists):
		default:
			t.Fatalf("writer %d: unexpected error %v", i, err)
		}
	}
	if winners != 1 {
		t.Fatalf("winners = %d, want 1", winners)
	}
}

func TestInvalidIDNeverTouchesDisk(t *testing.T) {
	s, dir := newStore(t)
	ctx := t.Context()

	bad := []string{"..", "../../etc/passwd", strings.Repeat("a", 63), strings.Repeat("A", 64), "aa/" + strings.Repeat("b", 60)}
	for _, v := range bad {
		if err := s.Put(ctx, v, strings.NewReader("x")); !errors.Is(err, ErrInvalidID) {
			t.Errorf("Put(%q) = %v, want ErrInvalidID", v, err)
		}
		if _, _, err := s.Get(ctx, v); !errors.Is(err, ErrInvalidID) {
			t.Errorf("Get(%q) = %v, want ErrInvalidID", v, err)
		}
		if _, err := s.Exists(ctx, v); !errors.Is(err, ErrInvalidID) {
			t.Errorf("Exists(%q) = %v, want ErrInvalidID", v, err)
		}
	}
	if n := countFiles(t, dir); n != 0 {
		t.Fatalf("data dir holds %d files, want none", n)
	}
}

func TestExists(t *testing.T) {
	s, _ := newStore(t)
	ctx := t.Context()
	if err := s.Put(ctx, id('e'), strings.NewReader("x")); err != nil {
		t.Fatalf("Put: %v", err)
	}
	for _, tc := range []struct {
		blob string
		want bool
	}{{id('e'), true}, {id('f'), false}} {
		got, err := s.Exists(ctx, tc.blob)
		if err != nil {
			t.Fatalf("Exists: %v", err)
		}
		if got != tc.want {
			t.Errorf("Exists(%s…) = %v, want %v", tc.blob[:4], got, tc.want)
		}
	}
}

func TestList(t *testing.T) {
	s, dir := newStore(t)
	ctx := t.Context()

	want := map[string]bool{}
	for _, c := range []byte{'a', 'b', 'c', 'd'} {
		if err := s.Put(ctx, id(c), strings.NewReader("x")); err != nil {
			t.Fatalf("Put: %v", err)
		}
		want[id(c)] = true
	}
	// Stray files that we did not write are ignored.
	if err := os.WriteFile(filepath.Join(dir, "blobs", "aa", "README"), []byte("x"), 0o600); err != nil {
		t.Fatalf("write stray file: %v", err)
	}

	got := map[string]bool{}
	if err := s.List(ctx, func(blob string) error {
		got[blob] = true
		return nil
	}); err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("listed %d ids, want %d", len(got), len(want))
	}
	for blob := range want {
		if !got[blob] {
			t.Errorf("missing id %s…", blob[:4])
		}
	}

	// List stops on the first error from fn and returns it.
	sentinel := errors.New("stop")
	seen := 0
	if err := s.List(ctx, func(string) error {
		seen++
		return sentinel
	}); !errors.Is(err, sentinel) {
		t.Fatalf("List error = %v, want sentinel", err)
	}
	if seen != 1 {
		t.Errorf("fn called %d times after error, want 1", seen)
	}
}

func TestPutReaderErrorLeavesNothing(t *testing.T) {
	s, dir := newStore(t)
	boom := errors.New("boom")

	err := s.Put(t.Context(), id('a'), io.MultiReader(strings.NewReader("half"), errReader{boom}))
	if !errors.Is(err, boom) {
		t.Fatalf("Put = %v, want boom", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "blobs", "aa", id('a'))); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("blob exists after failed Put: %v", err)
	}
	if n := countFiles(t, filepath.Join(dir, "tmp")); n != 0 {
		t.Errorf("tmp holds %d files after failed Put, want none", n)
	}
}

func TestManifestLifecycle(t *testing.T) {
	s, _ := newStore(t)
	ctx := t.Context()

	if _, _, err := s.Manifest(ctx); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Manifest = %v, want ErrNotFound", err)
	}
	// An ETag for a manifest that does not exist is a conflict.
	if _, err := s.PutManifest(ctx, []byte("v1"), `"deadbeef"`); !errors.Is(err, ErrManifestConflict) {
		t.Fatalf("PutManifest with stale etag = %v, want ErrManifestConflict", err)
	}

	etag1, err := s.PutManifest(ctx, []byte("v1"), "")
	if err != nil {
		t.Fatalf("create manifest: %v", err)
	}
	data, etag, err := s.Manifest(ctx)
	if err != nil {
		t.Fatalf("Manifest: %v", err)
	}
	if string(data) != "v1" || etag != etag1 {
		t.Fatalf("manifest = %q/%s, want v1/%s", data, etag, etag1)
	}
	if !strings.HasPrefix(etag, `"`) || !strings.HasSuffix(etag, `"`) {
		t.Errorf("etag %s is not quoted", etag)
	}

	if _, err := s.PutManifest(ctx, []byte("v2"), ""); !errors.Is(err, ErrIfMatchRequired) {
		t.Fatalf("PutManifest without etag = %v, want ErrIfMatchRequired", err)
	}
	if _, err := s.PutManifest(ctx, []byte("v2"), `"stale"`); !errors.Is(err, ErrManifestConflict) {
		t.Fatalf("PutManifest with wrong etag = %v, want ErrManifestConflict", err)
	}

	etag2, err := s.PutManifest(ctx, []byte("v2"), etag1)
	if err != nil {
		t.Fatalf("update manifest: %v", err)
	}
	if etag2 == etag1 {
		t.Error("etag did not change after update")
	}
	data, _, err = s.Manifest(ctx)
	if err != nil {
		t.Fatalf("Manifest: %v", err)
	}
	if string(data) != "v2" {
		t.Errorf("manifest = %q, want v2", data)
	}
}

func TestConcurrentPutManifestHasOneWinner(t *testing.T) {
	s, _ := newStore(t)
	ctx := t.Context()

	etag, err := s.PutManifest(ctx, []byte("round-0"), "")
	if err != nil {
		t.Fatalf("create manifest: %v", err)
	}

	const rounds, writers = 3, 8
	for round := range rounds {
		var wg sync.WaitGroup
		results := make([]string, writers)
		errs := make([]error, writers)
		for i := range writers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				results[i], errs[i] = s.PutManifest(ctx, fmt.Appendf(nil, "round-%d-%d", round, i), etag)
			}()
		}
		wg.Wait()

		winners := 0
		for i := range writers {
			switch {
			case errs[i] == nil:
				winners++
				etag = results[i]
			case errors.Is(errs[i], ErrManifestConflict):
			default:
				t.Fatalf("round %d writer %d: %v", round, i, errs[i])
			}
		}
		if winners != 1 {
			t.Fatalf("round %d: %d winners, want 1", round, winners)
		}
	}
}

func TestNewFSCleansTempDir(t *testing.T) {
	dir := t.TempDir()
	if _, err := NewFS(dir); err != nil {
		t.Fatalf("NewFS: %v", err)
	}
	stale := filepath.Join(dir, "tmp", "w-stale")
	if err := os.WriteFile(stale, []byte("partial"), 0o600); err != nil {
		t.Fatalf("write stale temp: %v", err)
	}
	if _, err := NewFS(dir); err != nil {
		t.Fatalf("NewFS again: %v", err)
	}
	if _, err := os.Stat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("stale temp file survived: %v", err)
	}
}

func TestPutRespectsCancelledContext(t *testing.T) {
	s, dir := newStore(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	if err := s.Put(ctx, id('a'), strings.NewReader("x")); !errors.Is(err, context.Canceled) {
		t.Fatalf("Put = %v, want context.Canceled", err)
	}
	if n := countFiles(t, dir); n != 0 {
		t.Fatalf("data dir holds %d files, want none", n)
	}
}

// countFiles returns the number of regular files below dir.
func countFiles(t *testing.T, dir string) int {
	t.Helper()
	n := 0
	err := filepath.WalkDir(dir, func(_ string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			n++
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}
	return n
}

type errReader struct{ err error }

func (e errReader) Read([]byte) (int, error) { return 0, e.err }
