package auth

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func newTestLimiter(t *testing.T, limit int, window time.Duration) (*RateLimiter, func(time.Duration)) {
	t.Helper()
	l := NewRateLimiter(limit, window)
	var mu sync.Mutex
	now := time.Unix(0, 0).UTC()
	l.now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	return l, func(d time.Duration) {
		mu.Lock()
		defer mu.Unlock()
		now = now.Add(d)
	}
}

func TestRateLimiterAllowsThenBlocks(t *testing.T) {
	l, advance := newTestLimiter(t, 3, time.Minute)

	for i := range 3 {
		if !l.Allow("10.0.0.1") {
			t.Fatalf("attempt %d was blocked", i+1)
		}
	}
	if l.Allow("10.0.0.1") {
		t.Fatal("the fourth attempt was allowed")
	}
	// Still blocked inside the window.
	advance(59 * time.Second)
	if l.Allow("10.0.0.1") {
		t.Fatal("attempt inside the window was allowed")
	}
	// The window elapsed.
	advance(time.Second)
	if !l.Allow("10.0.0.1") {
		t.Fatal("attempt after the window was blocked")
	}
}

func TestRateLimiterIsPerKey(t *testing.T) {
	l, _ := newTestLimiter(t, 1, time.Minute)

	if !l.Allow("10.0.0.1") || l.Allow("10.0.0.1") {
		t.Fatal("the first key does not follow the limit")
	}
	if !l.Allow("10.0.0.2") {
		t.Fatal("a different key was blocked by another key's attempts")
	}
}

func TestRateLimiterDefaults(t *testing.T) {
	l := NewRateLimiter(0, 0)
	if l.limit != DefaultLoginAttempts || l.window != DefaultLoginWindow {
		t.Fatalf("defaults = %d/%s, want %d/%s", l.limit, l.window, DefaultLoginAttempts, DefaultLoginWindow)
	}
}

func TestRateLimiterPurgesStaleKeys(t *testing.T) {
	l, advance := newTestLimiter(t, 1, time.Minute)

	for i := range purgeThreshold + 1 {
		l.Allow(fmt.Sprintf("10.0.0.%d", i))
	}
	advance(2 * time.Minute)
	l.Allow("10.0.1.1")

	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.buckets) != 1 {
		t.Fatalf("%d buckets after purge, want 1", len(l.buckets))
	}
}

func TestRateLimiterConcurrentUse(t *testing.T) {
	l := NewRateLimiter(100, time.Minute)

	var wg sync.WaitGroup
	for i := range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			l.Allow(fmt.Sprintf("10.0.0.%d", i%4))
		}()
	}
	wg.Wait()
}

// A stream of distinct addresses within one window must not make every
// Allow scan the whole map: the sweep runs once per window.
func TestRateLimiterSweepsOncePerWindow(t *testing.T) {
	l, advance := newTestLimiter(t, 1, time.Minute)

	for i := range purgeThreshold + 10 {
		l.Allow(fmt.Sprintf("10.0.%d.%d", i/256, i%256))
	}
	l.mu.Lock()
	first := l.nextPurge
	l.mu.Unlock()
	if first.IsZero() {
		t.Fatal("no sweep was scheduled above the threshold")
	}

	advance(30 * time.Second)
	l.Allow("10.1.0.1")
	l.mu.Lock()
	second, n := l.nextPurge, len(l.buckets)
	l.mu.Unlock()
	if !second.Equal(first) {
		t.Errorf("a second sweep ran within the window: next = %v, want %v", second, first)
	}
	if n != purgeThreshold+11 {
		t.Errorf("%d buckets, want %d: nothing had expired", n, purgeThreshold+11)
	}

	advance(time.Minute)
	l.Allow("10.1.0.2")
	l.mu.Lock()
	n = len(l.buckets)
	l.mu.Unlock()
	if n != 1 {
		t.Errorf("%d buckets after the window, want 1", n)
	}
}

func TestRateLimiterBoundsItsMemory(t *testing.T) {
	l, _ := newTestLimiter(t, 1, time.Minute)

	for i := range maxBuckets + 1 {
		l.Allow(fmt.Sprintf("%d", i))
	}
	l.mu.Lock()
	n := len(l.buckets)
	l.mu.Unlock()
	if n > maxBuckets {
		t.Fatalf("%d buckets, want at most %d", n, maxBuckets)
	}
	if !l.Allow("fresh") {
		t.Error("a fresh address was refused after the reset")
	}
}
