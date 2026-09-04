package auth

import (
	"crypto/sha256"
	"strings"
	"sync"
	"testing"
	"time"
)

// newTestSessions returns a store whose clock the test drives.
func newTestSessions(t *testing.T, ttl, maxAge time.Duration) (*SessionStore, func(time.Duration)) {
	t.Helper()
	s := NewSessionStore(ttl, maxAge)
	var mu sync.Mutex
	now := time.Unix(0, 0).UTC()
	s.now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	return s, func(d time.Duration) {
		mu.Lock()
		defer mu.Unlock()
		now = now.Add(d)
	}
}

func TestSessionCreateAndValidate(t *testing.T) {
	s, _ := newTestSessions(t, time.Hour, 30*24*time.Hour)

	token := s.Create()
	if token == "" {
		t.Fatal("empty session token")
	}
	if len(token) < 40 {
		t.Errorf("session token is only %d characters", len(token))
	}
	if !s.Valid(token) {
		t.Error("fresh session is not valid")
	}
	if s.Valid("") || s.Valid(token+"x") || s.Valid(strings.Repeat("a", len(token))) {
		t.Error("an unknown token validated")
	}
	if other := s.Create(); other == token {
		t.Error("two sessions share a token")
	}
}

func TestSessionStoresOnlyHashes(t *testing.T) {
	s, _ := newTestSessions(t, time.Hour, 30*24*time.Hour)
	token := s.Create()

	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.sessions[sha256.Sum256([]byte(token))]; !ok {
		t.Fatal("session is not keyed by the hash of its token")
	}
}

func TestSessionExpiryAndRefresh(t *testing.T) {
	s, advance := newTestSessions(t, time.Hour, 30*24*time.Hour)
	token := s.Create()

	advance(59 * time.Minute)
	if !s.Valid(token) {
		t.Fatal("session expired early")
	}
	// The check above refreshed the idle window.
	advance(59 * time.Minute)
	if !s.Valid(token) {
		t.Fatal("session was not refreshed on use")
	}
	advance(time.Hour)
	if s.Valid(token) {
		t.Fatal("expired session is still valid")
	}
	if s.Len() != 0 {
		t.Errorf("expired session was not dropped: %d left", s.Len())
	}
}

func TestSessionAbsoluteLifetime(t *testing.T) {
	s, advance := newTestSessions(t, time.Hour, 3*time.Hour)
	token := s.Create()

	// Constant use keeps the idle window open but cannot outlive maxAge.
	for range 3 {
		advance(50 * time.Minute)
		if !s.Valid(token) {
			t.Fatal("session expired before its absolute deadline")
		}
	}
	advance(50 * time.Minute)
	if s.Valid(token) {
		t.Fatal("session outlived its absolute deadline")
	}
	if s.Len() != 0 {
		t.Errorf("expired session was not dropped: %d left", s.Len())
	}
}

func TestSessionDefaultDurations(t *testing.T) {
	s := NewSessionStore(0, -time.Second)
	if s.ttl != DefaultSessionTTL || s.maxAge != DefaultSessionMaxAge {
		t.Errorf("ttl = %v, maxAge = %v; want defaults", s.ttl, s.maxAge)
	}
}

func TestSessionRevoke(t *testing.T) {
	s, _ := newTestSessions(t, time.Hour, 30*24*time.Hour)
	token := s.Create()

	s.Revoke(token)
	if s.Valid(token) {
		t.Fatal("revoked session is still valid")
	}
	s.Revoke(token) // revoking twice is harmless
	s.Revoke("unknown")
}

func TestSessionPurgeOnCreate(t *testing.T) {
	s, advance := newTestSessions(t, time.Hour, 30*24*time.Hour)
	for range 5 {
		s.Create()
	}
	advance(2 * time.Hour)

	live := s.Create()
	if s.Len() != 1 {
		t.Fatalf("%d sessions after purge, want 1", s.Len())
	}
	if !s.Valid(live) {
		t.Error("the live session was purged")
	}
}

func TestSessionConcurrentUse(t *testing.T) {
	s := NewSessionStore(time.Hour, 30*24*time.Hour)

	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			token := s.Create()
			if !s.Valid(token) {
				t.Error("session invalid right after creation")
			}
			s.Revoke(token)
		}()
	}
	wg.Wait()
	if s.Len() != 0 {
		t.Errorf("%d sessions left, want 0", s.Len())
	}
}
