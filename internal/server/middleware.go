package server

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"runtime/debug"
	"strings"
	"time"
)

// requireSession rejects requests without a live session cookie.
func (s *Server) requireSession(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil || !s.sessions.Valid(c.Value) {
			writeError(w, http.StatusUnauthorized, codeUnauthorized)
			return
		}
		next(w, r)
	})
}

// securityHeaders sets the headers that apply to every response.
//
// The Content-Security-Policy is not among them: the web app authors its own
// policy at build time, because only it knows the hashes of the scripts it
// inlines, and the web package serves it with the app shell.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		if isAPIPath(r.URL.Path) {
			// Ciphertext is cacheable in principle, but nothing about the
			// archive should linger in a shared cache or on disk.
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// csrf rejects state-changing requests that a browser reports as cross-site.
func csrf(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if !sameOrigin(r) {
				writeError(w, http.StatusForbidden, codeForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// sameOrigin reports whether a state-changing request originates from the app
// itself.
//
// Under the Vite dev proxy the browser still talks to a single origin, the dev
// server, which forwards /api to this process; both headers therefore say
// same-origin exactly as they do in production.
func sameOrigin(r *http.Request) bool {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" {
		return site == "same-origin" || site == "none"
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		return err == nil && u.Host == r.Host
	}
	// Neither header means the request did not come from a browser, so it
	// cannot be a cross-site forgery: a forged request is by definition one a
	// browser made on behalf of another site, and every browser that can reach
	// this code sends Sec-Fetch-Site, or at least Origin, on these methods.
	// The session cookie is SameSite=Strict on top of that.
	return true
}

// logRequests logs one line per request. Bodies are never touched.
func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &recorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		s.log.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.statusCode(),
			"bytes", rec.written,
			"duration_ms", time.Since(start).Milliseconds(),
			"remote", clientIP(r),
		)
	})
}

// recoverer turns a panic in a handler into a 500 instead of a dropped
// connection, and logs it with a stack trace.
func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			// ErrAbortHandler is the net/http way of aborting a response on
			// purpose; leave it to the server.
			if err, ok := v.(error); ok && errors.Is(err, http.ErrAbortHandler) {
				panic(v)
			}
			s.log.Error("panic",
				"method", r.Method,
				"path", r.URL.Path,
				"panic", v,
				"stack", string(debug.Stack()),
			)
			writeError(w, http.StatusInternalServerError, codeInternal)
		}()
		next.ServeHTTP(w, r)
	})
}

// recorder captures the status code and size of a response for logging.
type recorder struct {
	http.ResponseWriter
	status  int
	written int64
}

func (r *recorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *recorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(b)
	r.written += int64(n)
	return n, err
}

// Unwrap lets http.NewResponseController reach the underlying writer, so a
// handler wrapped by the logger keeps Flush and the deadline setters.
func (r *recorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func (r *recorder) statusCode() int {
	if r.status == 0 {
		return http.StatusOK
	}
	return r.status
}

func isAPIPath(path string) bool { return strings.HasPrefix(path, "/api/") }

// clientIP returns the address the connection came from.
//
// X-Forwarded-For and friends are deliberately ignored: they are
// attacker-controlled unless a trusted proxy rewrites them, and honouring them
// would let a single client sidestep the login rate limiter.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
