package auth

import (
	"sync"
	"time"
)

// Default login rate limit: attempts per window and per client address.
const (
	DefaultLoginAttempts = 10
	DefaultLoginWindow   = time.Minute
)

// purgeThreshold is the number of tracked keys above which Allow sweeps expired
// entries. Sweeping on every call would be O(n) per request, which an attacker
// could turn into quadratic work by spraying source addresses.
const purgeThreshold = 1024

// RateLimiter is a fixed-window counter keyed by client address, used to slow
// down password guessing against /api/login.
type RateLimiter struct {
	limit  int
	window time.Duration
	now    func() time.Time

	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	count int
	reset time.Time
}

// NewRateLimiter returns a limiter allowing limit events per window and key.
// Non-positive values fall back to the defaults.
func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	if limit <= 0 {
		limit = DefaultLoginAttempts
	}
	if window <= 0 {
		window = DefaultLoginWindow
	}
	return &RateLimiter{
		limit:   limit,
		window:  window,
		now:     time.Now,
		buckets: make(map[string]*bucket),
	}
}

// Allow records an attempt for key and reports whether it is within the limit.
func (l *RateLimiter) Allow(key string) bool {
	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.buckets) > purgeThreshold {
		l.purge(now)
	}

	b, ok := l.buckets[key]
	if !ok || !now.Before(b.reset) {
		l.buckets[key] = &bucket{count: 1, reset: now.Add(l.window)}
		return true
	}
	b.count++
	return b.count <= l.limit
}

// purge drops windows that have elapsed. The caller holds the lock.
func (l *RateLimiter) purge(now time.Time) {
	for key, b := range l.buckets {
		if !now.Before(b.reset) {
			delete(l.buckets, key)
		}
	}
}
