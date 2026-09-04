// Package server exposes mailarchive's HTTP API: an authenticated,
// write-once blob store plus one ETag-versioned manifest, and optionally the
// embedded web app. It never inspects or decrypts what it stores.
package server

import (
	"log/slog"
	"net/http"

	"github.com/Angelmmiguel/mailarchive/internal/auth"
	"github.com/Angelmmiguel/mailarchive/internal/store"
)

// Defaults for Config.
const (
	DefaultMaxBlobBytes     = 64 << 20 // 64 MiB
	DefaultMaxManifestBytes = 16 << 20 // 16 MiB
	DefaultMaxExistsIDs     = 10000
)

// sessionCookie is the name of the session cookie set on login.
const sessionCookie = "mailarchive_session"

// Config configures a Server. The zero value of every size field falls back to
// the corresponding default.
type Config struct {
	// MaxBlobBytes is the largest accepted blob body.
	MaxBlobBytes int64
	// MaxManifestBytes is the largest accepted manifest body.
	MaxManifestBytes int64
	// MaxExistsIDs is the largest accepted batch for POST /api/blobs/exists.
	MaxExistsIDs int
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
	mux.HandleFunc("POST /api/setup", s.handleSetup)
	mux.HandleFunc("POST /api/login", s.handleLogin)

	mux.Handle("POST /api/logout", s.requireSession(s.handleLogout))
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

	return s.recoverer(s.logRequests(securityHeaders(csrf(mux))))
}
