package auth

import (
	"crypto/sha256"
	"sync"
	"time"
)

// DefaultSessionTTL is the idle lifetime of a session.
const DefaultSessionTTL = 24 * time.Hour

// DefaultSessionMaxAge is the total lifetime of a session, however often it is
// used.
const DefaultSessionMaxAge = 7 * 24 * time.Hour

// session is one live login: an idle window that use extends and a hard
// deadline that nothing extends.
type session struct {
	expiry   time.Time
	absolute time.Time
}

// SessionStore holds the live sessions of the single archive user in memory.
// Sessions are deliberately not persisted: a server restart logs the user out.
//
// Only the SHA-256 of each token is kept, so a memory dump or a stray dump of
// the map yields nothing that can be replayed as a cookie.
type SessionStore struct {
	ttl    time.Duration
	maxAge time.Duration
	now    func() time.Time

	mu       sync.Mutex
	sessions map[[sha256.Size]byte]session // token hash -> deadlines
}

// NewSessionStore returns an empty store whose sessions expire after ttl of
// inactivity and, in any case, maxAge after they were created: a stolen cookie
// that is used every day must still die. Either duration zero or less uses
// DefaultSessionTTL or DefaultSessionMaxAge.
func NewSessionStore(ttl, maxAge time.Duration) *SessionStore {
	if ttl <= 0 {
		ttl = DefaultSessionTTL
	}
	if maxAge <= 0 {
		maxAge = DefaultSessionMaxAge
	}
	return &SessionStore{
		ttl:      ttl,
		maxAge:   maxAge,
		now:      time.Now,
		sessions: make(map[[sha256.Size]byte]session),
	}
}

// Create returns a new session token. The caller sends it to the client as a
// cookie; the store keeps only its hash.
func (s *SessionStore) Create() string {
	token := randomToken()

	s.mu.Lock()
	defer s.mu.Unlock()
	s.purge()
	now := s.now()
	s.sessions[sha256.Sum256([]byte(token))] = session{
		expiry:   now.Add(s.ttl),
		absolute: now.Add(s.maxAge),
	}
	return token
}

// Valid reports whether token names a live session and, if so, extends it by
// another idle ttl, up to its absolute deadline.
//
// The map lookup is not constant time, but its key is a SHA-256 digest: an
// attacker who can time it still cannot work backwards to a token.
func (s *SessionStore) Valid(token string) bool {
	if token == "" {
		return false
	}
	key := sha256.Sum256([]byte(token))

	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[key]
	if !ok {
		return false
	}
	now := s.now()
	if !now.Before(sess.expiry) || !now.Before(sess.absolute) {
		delete(s.sessions, key)
		return false
	}
	sess.expiry = now.Add(s.ttl)
	s.sessions[key] = sess
	return true
}

// Revoke ends the session named by token, if any.
func (s *SessionStore) Revoke(token string) {
	key := sha256.Sum256([]byte(token))

	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, key)
}

// Len returns the number of stored sessions, expired ones included.
func (s *SessionStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessions)
}

// purge drops expired sessions. The caller holds the lock.
func (s *SessionStore) purge() {
	now := s.now()
	for key, sess := range s.sessions {
		if !now.Before(sess.expiry) || !now.Before(sess.absolute) {
			delete(s.sessions, key)
		}
	}
}
