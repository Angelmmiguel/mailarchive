//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly

package store

import (
	"errors"
	"fmt"
	"io"
	"os"
	"syscall"
)

// lockDir takes an exclusive advisory lock on root's lock file, held until
// the returned closer is closed, so that two processes cannot serve the
// same data directory. A directory another process holds fails with
// ErrLocked. A filesystem without lock support (some network mounts) is
// reported as an error too: better to refuse to start than to promise
// exclusivity that is not there.
func lockDir(root string) (io.Closer, error) {
	f, err := os.OpenFile(lockPath(root), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("store: open lock file: %w", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrLocked
		}
		return nil, fmt.Errorf("store: lock data dir: %w", err)
	}
	return f, nil
}
