package auth

import (
	"bytes"
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

func sessionKey(b byte) []byte {
	key := make([]byte, SessionKeyLen)
	for i := range key {
		key[i] = b
	}
	return key
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

func TestSessionRevokeOthers(t *testing.T) {
	s, _ := newTestSessions(t, time.Hour, 30*24*time.Hour)
	keep := s.Create()
	others := []string{s.Create(), s.Create()}
	s.SetKey(keep, sessionKey(1))

	s.RevokeOthers(keep)
	if !s.Valid(keep) {
		t.Fatal("RevokeOthers dropped the named session")
	}
	if key, ok := s.Key(keep); !ok || !bytes.Equal(key, sessionKey(1)) {
		t.Error("RevokeOthers dropped the named session's key")
	}
	for _, token := range others {
		if s.Valid(token) {
			t.Error("RevokeOthers kept another session")
		}
	}
	if s.Len() != 1 {
		t.Errorf("%d sessions left, want 1", s.Len())
	}

	// An unknown token keeps nothing: every session goes.
	s.RevokeOthers("unknown")
	if s.Valid(keep) || s.Len() != 0 {
		t.Error("RevokeOthers with an unknown token kept a session")
	}
}

func TestSessionKey(t *testing.T) {
	s, _ := newTestSessions(t, time.Hour, 30*24*time.Hour)
	token := s.Create()

	if key, ok := s.Key(token); ok || key != nil {
		t.Fatal("a fresh session has a key")
	}
	if s.SetKey("unknown", sessionKey(1)) {
		t.Fatal("SetKey accepted an unknown token")
	}
	if s.SetKey(token, sessionKey(1)[:31]) || s.SetKey(token, append(sessionKey(1), 0)) || s.SetKey(token, nil) {
		t.Fatal("SetKey accepted a key that is not SessionKeyLen bytes")
	}
	if _, ok := s.Key(token); ok {
		t.Fatal("a rejected SetKey stored a key")
	}

	in := sessionKey(1)
	if !s.SetKey(token, in) {
		t.Fatal("SetKey rejected a live session")
	}
	in[0] = 0xff // the store keeps its own copy
	out, ok := s.Key(token)
	if !ok || !bytes.Equal(out, sessionKey(1)) {
		t.Fatalf("Key = %x, %v; want the key that was set", out, ok)
	}
	out[0] = 0xff // and hands out copies
	if again, _ := s.Key(token); !bytes.Equal(again, sessionKey(1)) {
		t.Fatal("Key returned the store's own backing array")
	}

	// A second SetKey replaces the first.
	if !s.SetKey(token, sessionKey(2)) {
		t.Fatal("second SetKey failed")
	}
	if out, _ := s.Key(token); !bytes.Equal(out, sessionKey(2)) {
		t.Fatalf("Key after replacement = %x, want the new key", out)
	}
	if _, ok := s.Key("unknown"); ok {
		t.Error("Key returned a key for an unknown token")
	}
}

func TestSessionKeyGoesWithTheSession(t *testing.T) {
	t.Run("revoke", func(t *testing.T) {
		s, _ := newTestSessions(t, time.Hour, 30*24*time.Hour)
		token := s.Create()
		s.SetKey(token, sessionKey(1))
		s.Revoke(token)
		if _, ok := s.Key(token); ok {
			t.Fatal("key survived Revoke")
		}
	})
	t.Run("expiry", func(t *testing.T) {
		s, advance := newTestSessions(t, time.Hour, 30*24*time.Hour)
		token := s.Create()
		s.SetKey(token, sessionKey(1))
		advance(2 * time.Hour)
		if _, ok := s.Key(token); !ok {
			// Only Valid checks the deadlines; the store still holds the
			// entry until a request or a purge drops it.
			t.Fatal("Key was not expected to check expiry")
		}
		if s.Valid(token) {
			t.Fatal("expired session is still valid")
		}
		if _, ok := s.Key(token); ok {
			t.Fatal("key survived expiry")
		}
	})
	t.Run("purge", func(t *testing.T) {
		s, advance := newTestSessions(t, time.Hour, 30*24*time.Hour)
		token := s.Create()
		s.SetKey(token, sessionKey(1))
		advance(2 * time.Hour)
		s.Create()
		if _, ok := s.Key(token); ok {
			t.Fatal("key survived the purge")
		}
	})
	t.Run("revoke others", func(t *testing.T) {
		s, _ := newTestSessions(t, time.Hour, 30*24*time.Hour)
		token := s.Create()
		s.SetKey(token, sessionKey(1))
		s.RevokeOthers(s.Create())
		if _, ok := s.Key(token); ok {
			t.Fatal("key survived RevokeOthers from another session")
		}
	})
}

func TestSessionKeyDoesNotRefresh(t *testing.T) {
	s, advance := newTestSessions(t, time.Hour, 30*24*time.Hour)
	token := s.Create()

	advance(30 * time.Minute)
	s.SetKey(token, sessionKey(1))
	advance(20 * time.Minute)
	s.Key(token)
	advance(20 * time.Minute)
	// 70 minutes since creation with no Valid call in between.
	if s.Valid(token) {
		t.Fatal("SetKey or Key refreshed the idle window")
	}
}

func TestSessionDropWipesKey(t *testing.T) {
	s, _ := newTestSessions(t, time.Hour, 30*24*time.Hour)
	token := s.Create()
	s.SetKey(token, sessionKey(1))

	s.mu.Lock()
	backing := s.sessions[sha256.Sum256([]byte(token))].key
	s.mu.Unlock()

	s.Revoke(token)
	if !bytes.Equal(backing, make([]byte, SessionKeyLen)) {
		t.Fatal("Revoke did not wipe the key's backing array")
	}
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
	for i := range byte(16) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			token := s.Create()
			if !s.Valid(token) {
				t.Error("session invalid right after creation")
			}
			if !s.SetKey(token, sessionKey(i)) {
				t.Error("SetKey failed on a live session")
			}
			if key, ok := s.Key(token); !ok || !bytes.Equal(key, sessionKey(i)) {
				t.Error("Key returned the wrong key")
			}
			s.Revoke(token)
		}()
	}
	wg.Wait()
	if s.Len() != 0 {
		t.Errorf("%d sessions left, want 0", s.Len())
	}
}
