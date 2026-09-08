// Package server exposes mailarchive's HTTP API: an authenticated,
// write-once blob store plus one ETag-versioned manifest, and optionally the
// embedded web app. It never inspects or decrypts what it stores.
package server

import (
	"log/slog"
	"net/http"
	"net/netip"
	"sync"
	"time"

	"github.com/Angelmmiguel/mailarchive/internal/auth"
	"github.com/Angelmmiguel/mailarchive/internal/store"
)

// Defaults for Config.
const (
	DefaultMaxBlobBytes     = 64 << 20 // 64 MiB
	DefaultMaxManifestBytes = 16 << 20 // 16 MiB
	DefaultMaxExistsIDs     = 10000
	// DefaultBodyTimeout is how long a request other than a blob upload may
	// take to arrive in full, a 16 MiB manifest over a slow link included.
	DefaultBodyTimeout = 2 * time.Minute
	// DefaultBlobTimeout is how long a blob upload may take to arrive: a
	// 64 MiB blob over a 1 Mbit/s link needs nine minutes.
	DefaultBlobTimeout = 15 * time.Minute
)

// sessionCookie is the name of the session cookie set on login.
const sessionCookie = "mailarchive_session"

// Config configures a Server. The zero value of every size and duration
// field falls back to the corresponding default.
type Config struct {
	// MaxBlobBytes is the largest accepted blob body.
	MaxBlobBytes int64
	// MaxManifestBytes is the largest accepted manifest body.
	MaxManifestBytes int64
	// MaxExistsIDs is the largest accepted batch for POST /api/blobs/exists.
	MaxExistsIDs int
	// BodyTimeout bounds how long a request may take to arrive in full,
	// blob uploads aside; a body that never completes is cut off, so that
	// it cannot hold a connection open for as long as the sender likes.
	BodyTimeout time.Duration
	// BlobTimeout is BodyTimeout for blob uploads, which are large.
	BlobTimeout time.Duration
	// TrustedProxies are the addresses a reverse proxy in front of the
	// server connects from. For a connection from one of them the client
	// address, which keys the rate limiter, is the last address the proxy
	// appended to X-Forwarded-For; from anywhere else that header is
	// ignored, since a client can write anything into it.
	TrustedProxies []netip.Prefix
	// Secure marks the session cookie Secure. Leave it false only on a plain
	// HTTP LAN deployment.
	Secure bool
	// UI serves the web app. Nil disables it and every non-API path 404s.
	UI http.Handler
	// Logger receives request and error logs. Nil uses slog.Default.
	Logger *slog.Logger
}

// Server is the HTTP handler for the mailarchive API.
type Server struct {
	cfg      Config
	store    store.Store
	creds    *auth.Credentials
	sessions *auth.SessionStore
	limiter  *auth.RateLimiter
	log      *slog.Logger
	handler  http.Handler

	// accountMu serialises what reads or changes the account as a whole:
	// setup, login and rekey. Each of those is several steps against the
	// credentials, the manifest and the sessions, and the steps of two of
	// them must not interleave.
	accountMu sync.Mutex
}

// New wires a Server from its dependencies and applies Config defaults.
func New(cfg Config, st store.Store, creds *auth.Credentials, sessions *auth.SessionStore, limiter *auth.RateLimiter) *Server {
	if cfg.MaxBlobBytes <= 0 {
		cfg.MaxBlobBytes = DefaultMaxBlobBytes
	}
	if cfg.MaxManifestBytes <= 0 {
		cfg.MaxManifestBytes = DefaultMaxManifestBytes
	}
	if cfg.MaxExistsIDs <= 0 {
		cfg.MaxExistsIDs = DefaultMaxExistsIDs
	}
	if cfg.BodyTimeout <= 0 {
		cfg.BodyTimeout = DefaultBodyTimeout
	}
	if cfg.BlobTimeout <= 0 {
		cfg.BlobTimeout = DefaultBlobTimeout
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}

	s := &Server{
		cfg:      cfg,
		store:    st,
		creds:    creds,
		sessions: sessions,
		limiter:  limiter,
		log:      cfg.Logger,
	}
	s.handler = s.routes()
	return s
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	// Open routes: everything else needs a session.
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/kdf", s.handleKDF)
	mux.HandleFunc("POST /api/setup", s.handleSetup)
	mux.HandleFunc("POST /api/login", s.handleLogin)

	mux.Handle("POST /api/logout", s.requireSession(s.handleLogout))
	mux.Handle("POST /api/rekey", s.requireSession(s.handleRekey))
	mux.Handle("PUT /api/session/key", s.requireSession(s.handlePutSessionKey))
	mux.Handle("GET /api/session/key", s.requireSession(s.handleGetSessionKey))
	mux.Handle("GET /api/manifest", s.requireSession(s.handleGetManifest))
	mux.Handle("PUT /api/manifest", s.requireSession(s.handlePutManifest))
	mux.Handle("GET /api/blobs", s.requireSession(s.handleListBlobs))
	mux.Handle("POST /api/blobs/exists", s.requireSession(s.handleBlobsExist))
	mux.Handle("GET /api/blobs/{id}", s.requireSession(s.handleGetBlob))
	mux.Handle("HEAD /api/blobs/{id}", s.requireSession(s.handleGetBlob))
	mux.Handle("PUT /api/blobs/{id}", s.requireSession(s.handlePutBlob))

	// Unknown API paths answer in JSON instead of falling through to the SPA.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, codeNotFound)
	})

	if s.cfg.UI != nil {
		mux.Handle("/", s.cfg.UI)
	} else {
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		})
	}

	return s.recoverer(s.logRequests(s.bodyDeadline(securityHeaders(csrf(mux)))))
}
