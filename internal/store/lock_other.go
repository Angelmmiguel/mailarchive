//go:build !(linux || darwin || freebsd || netbsd || openbsd || dragonfly)

package store

import "io"

// lockDir is a no-op where flock(2) is not available: nothing stops a second
// process from opening the same data directory there.
func lockDir(string) (io.Closer, error) { return io.NopCloser(nil), nil }
