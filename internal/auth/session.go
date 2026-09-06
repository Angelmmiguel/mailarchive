package auth

import (
	"bytes"
	"crypto/sha256"
	"sync"
	"time"
)

// DefaultSessionTTL is the idle lifetime of a session.
const DefaultSessionTTL = 24 * time.Hour

// DefaultSessionMaxAge is the total lifetime of a session, however often it is
// used.
const DefaultSessionMaxAge = 7 * 24 * time.Hour

// SessionKeyLen is the required length in bytes of a session key.
const SessionKeyLen = 32

// session is one live login: an idle window that use extends, a hard
// deadline that nothing extends, and the client's session key, if it has set
// one.
type session struct {
	expiry   time.Time
	absolute time.Time
	key      []byte // nil until SetKey
}

// SessionStore holds the live sessions of the single archive user in memory.
// Sessions are deliberately not persisted: a server restart logs the user out.
//
// Only the SHA-256 of each token is kept, so a memory dump or a stray dump of
// the map yields nothing that can be replayed as a cookie.
//
// A session may carry a key: the server half of the client's split session
// key, which lets the browser survive a page refresh without the passphrase.
// It lives only here, never on disk, and goes away with the session.
type SessionStore struct {
	ttl    time.Duration
	maxAge time.Duration
	now    func() time.Time

	mu       sync.Mutex
	sessions map[[sha256.Size]byte]session // token hash -> session
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
// another idle ttl, up to its absolute deadline. It is the only method that
// refreshes the idle window: every authenticated request passes through it,
// so SetKey and Key need not.
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
		s.drop(key)
		return false
	}
	sess.expiry = now.Add(s.ttl)
	s.sessions[key] = sess
	return true
}

// SetKey stores a copy of key on the session named by token, replacing any
// previous one. It reports false if there is no such session or key is not
// SessionKeyLen bytes. Expiry is not checked here: the caller has just
// validated the token.
func (s *SessionStore) SetKey(token string, key []byte) bool {
	if len(key) != SessionKeyLen {
		return false
	}
	id := sha256.Sum256([]byte(token))

	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok {
		return false
	}
	clear(sess.key)
	sess.key = bytes.Clone(key)
	s.sessions[id] = sess
	return true
}

// Key returns a copy of the session key of the session named by token, or
// false if there is no such session or it has no key.
func (s *SessionStore) Key(token string) ([]byte, bool) {
	id := sha256.Sum256([]byte(token))

	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok || sess.key == nil {
		return nil, false
	}
	return bytes.Clone(sess.key), true
}

// Revoke ends the session named by token, if any.
func (s *SessionStore) Revoke(token string) {
	key := sha256.Sum256([]byte(token))

	s.mu.Lock()
	defer s.mu.Unlock()
	s.drop(key)
}

// RevokeOthers ends every session except the one named by token. It is
// called after a rekey, so a session opened with the old credentials cannot
// outlive them.
func (s *SessionStore) RevokeOthers(token string) {
	keep := sha256.Sum256([]byte(token))

	s.mu.Lock()
	defer s.mu.Unlock()
	for key := range s.sessions {
		if key != keep {
			s.drop(key)
		}
	}
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
			s.drop(key)
		}
	}
}

// drop removes a session and wipes its key first. The caller holds the lock.
//
// Wiping is best effort: Go may already have copied the bytes (a GC move, a
// stack copy) and the copies handed out by Key are the caller's problem. It
// still shortens how long the key sits in freed memory.
func (s *SessionStore) drop(key [sha256.Size]byte) {
	clear(s.sessions[key].key)
	delete(s.sessions, key)
}
