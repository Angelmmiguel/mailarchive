package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/Angelmmiguel/mailarchive/internal/auth"
	"github.com/Angelmmiguel/mailarchive/internal/store"
)

// Error codes sent to the client as {"error":"<code>"}. They are stable
// identifiers, never free-form messages: an internal error must not describe
// the state of the server.
const (
	codeBadRequest      = "bad_request"
	codeUnauthorized    = "unauthorized"
	codeWrongCredential = "wrong_credential" //nolint:gosec // an error code, not a secret
	codeForbidden       = "forbidden"
	codeNotFound        = "not_found"
	codeNotSetup        = "not_setup"
	codeAlreadySetup    = "already_setup"
	codeInvalidID       = "invalid_id"
	codeInvalidAuthKey  = "invalid_auth_key"
	codeInvalidKDF      = "invalid_kdf"
	codeInvalidSessKey  = "invalid_session_key"
	codeExists          = "exists"
	codeTooLarge        = "too_large"
	codeTooManyIDs      = "too_many_ids"
	codeRateLimited     = "rate_limited"
	codeConflict        = "conflict"
	codeIfMatchRequired = "if_match_required"
	codeInternal        = "internal"
)

// Body limits for the small JSON routes. Login and the session key carry one
// base64 key; setup adds a second key and the KDF parameters, themselves
// bounded by auth.MaxKDFBytes. Setup and rekey also carry a base64 manifest,
// so their limits are derived from the manifest limit in the handlers.
const (
	maxCredentialBody = 4 << 10
	maxSetupBody      = 8 << 10
)

const contentTypeOctet = "application/octet-stream"

// handleHealth reports liveness and whether the archive has been set up, so
// the web app can decide between the setup and the unlock screen.
func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, struct {
		Status string `json:"status"`
		Setup  bool   `json:"setup"`
	}{Status: "ok", Setup: s.creds.IsSetup()})
}

// handleKDF serves the stored KDF parameters, which the client needs before
// it can derive its auth key and log in. They are public by design: the salt
// only defeats precomputation and on its own gives nothing to test guesses
// against. The body is the object exactly as stored and nothing else.
func (s *Server) handleKDF(w http.ResponseWriter, _ *http.Request) {
	kdf := s.creds.KDF()
	if kdf == nil {
		writeError(w, http.StatusConflict, codeNotSetup)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Content-Length", strconv.Itoa(len(kdf)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(kdf)
}

// handleSetup creates the archive's single account together with its first
// manifest. One request, because the manifest holds the wrapped DEK and the
// DEK exists only in the client's memory until it is stored: credentials
// without a manifest would be an account nothing can decrypt, and setup can
// never be repeated. The first successful call wins and the route is refused
// from then on: an empty archive belongs to whoever reaches it first, which
// is the operator on a private network.
func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	if s.creds.IsSetup() {
		writeError(w, http.StatusConflict, codeAlreadySetup)
		return
	}
	var req struct {
		AuthKey         string          `json:"auth_key"`
		RecoveryAuthKey string          `json:"recovery_auth_key"`
		KDF             json.RawMessage `json:"kdf"`
		Manifest        string          `json:"manifest"`
	}
	if !readJSON(w, r, s.cfg.MaxManifestBytes*4/3+maxSetupBody, &req) {
		return
	}
	key, err := auth.DecodeAuthKey(req.AuthKey)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidAuthKey)
		return
	}
	recoveryKey, err := auth.DecodeAuthKey(req.RecoveryAuthKey)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidAuthKey)
		return
	}
	if err := auth.ValidateKDF(req.KDF); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidKDF)
		return
	}
	if req.Manifest == "" {
		writeError(w, http.StatusBadRequest, codeBadRequest)
		return
	}
	manifest, err := base64.StdEncoding.DecodeString(req.Manifest)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest)
		return
	}
	if int64(len(manifest)) > s.cfg.MaxManifestBytes {
		writeError(w, http.StatusRequestEntityTooLarge, codeTooLarge)
		return
	}

	// Unauthenticated route: share the login limiter and count every attempt.
	if !s.limiter.Allow(clientIP(r)) {
		s.log.Warn("setup rate limited", "remote", clientIP(r))
		writeError(w, http.StatusTooManyRequests, codeRateLimited)
		return
	}

	// A manifest may already exist: an earlier attempt that crashed after
	// writing it but before the credentials left an orphan. This route is
	// only reachable while there are no credentials, so that orphan belongs
	// to nobody and is safe to replace, which PutManifest only does under
	// the ETag it currently has.
	_, etag, err := s.store.Manifest(r.Context())
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, r, err)
		return
	}
	if _, err := s.store.PutManifest(r.Context(), manifest, etag); err != nil {
		if errors.Is(err, store.ErrManifestConflict) {
			writeError(w, http.StatusConflict, codeConflict)
			return
		}
		s.fail(w, r, err)
		return
	}
	// The manifest is written. If the credentials do not follow, it is either
	// the manifest of a concurrent setup that won the race and wrote after
	// us, or an orphan the next setup overwrites; neither needs cleaning up.
	switch err := s.creds.Setup(key, recoveryKey, req.KDF); {
	case err == nil:
	case errors.Is(err, auth.ErrAlreadySetup):
		writeError(w, http.StatusConflict, codeAlreadySetup)
		return
	default:
		s.log.Error("setup: manifest written but credentials not created", "error", err)
		writeError(w, http.StatusInternalServerError, codeInternal)
		return
	}
	s.log.Info("archive set up", "remote", clientIP(r))
	w.WriteHeader(http.StatusCreated)
}

// handleLogin exchanges the client's auth key for a session cookie.
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !s.creds.IsSetup() {
		writeError(w, http.StatusConflict, codeNotSetup)
		return
	}
	// Rate limit before doing any work, and count every attempt rather than
	// only the failures, so guessing cannot be hidden behind valid logins.
	if !s.limiter.Allow(clientIP(r)) {
		s.log.Warn("login rate limited", "remote", clientIP(r))
		writeError(w, http.StatusTooManyRequests, codeRateLimited)
		return
	}
	var req struct {
		AuthKey string `json:"auth_key"`
	}
	if !readJSON(w, r, maxCredentialBody, &req) {
		return
	}
	key, err := auth.DecodeAuthKey(req.AuthKey)
	if err != nil || !s.creds.Verify(key) {
		s.log.Warn("login failed", "remote", clientIP(r))
		writeError(w, http.StatusUnauthorized, codeUnauthorized)
		return
	}
	s.setSessionCookie(w, s.sessions.Create())
	w.WriteHeader(http.StatusNoContent)
}

// handleLogout revokes the current session, and with it the session key.
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.sessions.Revoke(sessionToken(r))
	s.clearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

// handleRekey replaces credentials and manifest in one call, so a passphrase
// or recovery key change cannot leave one credential logging in while the
// other decrypts. The manifest goes first under its If-Match, exactly as
// PUT /api/manifest; then the credentials file is replaced; then every other
// session is revoked, since a session opened with the old passphrase must
// not survive it.
//
// The session alone is not proof enough: a hijacked cookie could otherwise
// rotate both keys and lock the owner out. The caller must also present a
// current credential, either auth key, as a password change asks for the old
// password. That check is a second place to guess a credential, so it shares
// the login rate limiter. A rejected credential answers 401 wrong_credential,
// distinct from the unauthorized of a dead session, so the client can tell
// "wrong passphrase" from "unlock again".
func (s *Server) handleRekey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CurrentAuthKey  string          `json:"current_auth_key"`
		AuthKey         string          `json:"auth_key"`
		RecoveryAuthKey string          `json:"recovery_auth_key"`
		KDF             json.RawMessage `json:"kdf"`
		Manifest        string          `json:"manifest"`
		IfMatch         string          `json:"if_match"`
	}
	if !readJSON(w, r, s.cfg.MaxManifestBytes*4/3+maxSetupBody, &req) {
		return
	}
	current, err := auth.DecodeAuthKey(req.CurrentAuthKey)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidAuthKey)
		return
	}
	if req.AuthKey == "" && req.RecoveryAuthKey == "" && req.KDF == nil {
		writeError(w, http.StatusBadRequest, codeBadRequest)
		return
	}
	// Everything is validated before the manifest is written: a rejected
	// field must leave both manifest and credentials untouched.
	var key, recoveryKey []byte
	if req.AuthKey != "" {
		if key, err = auth.DecodeAuthKey(req.AuthKey); err != nil {
			writeError(w, http.StatusBadRequest, codeInvalidAuthKey)
			return
		}
	}
	if req.RecoveryAuthKey != "" {
		if recoveryKey, err = auth.DecodeAuthKey(req.RecoveryAuthKey); err != nil {
			writeError(w, http.StatusBadRequest, codeInvalidAuthKey)
			return
		}
	}
	if req.KDF != nil {
		if err = auth.ValidateKDF(req.KDF); err != nil {
			writeError(w, http.StatusBadRequest, codeInvalidKDF)
			return
		}
	}
	manifest, err := base64.StdEncoding.DecodeString(req.Manifest)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeBadRequest)
		return
	}
	if int64(len(manifest)) > s.cfg.MaxManifestBytes {
		writeError(w, http.StatusRequestEntityTooLarge, codeTooLarge)
		return
	}

	// As in login, every attempt counts, not only the failures.
	if !s.limiter.Allow(clientIP(r)) {
		s.log.Warn("rekey rate limited", "remote", clientIP(r))
		writeError(w, http.StatusTooManyRequests, codeRateLimited)
		return
	}
	if !s.creds.Verify(current) {
		s.log.Warn("rekey credential rejected", "remote", clientIP(r))
		writeError(w, http.StatusUnauthorized, codeWrongCredential)
		return
	}

	etag, err := s.store.PutManifest(r.Context(), manifest, strings.TrimSpace(req.IfMatch))
	switch {
	case err == nil:
	case errors.Is(err, store.ErrIfMatchRequired):
		writeError(w, http.StatusPreconditionRequired, codeIfMatchRequired)
		return
	case errors.Is(err, store.ErrManifestConflict):
		writeError(w, http.StatusPreconditionFailed, codeConflict)
		return
	default:
		s.fail(w, r, err)
		return
	}
	if err := s.creds.Rotate(key, recoveryKey, req.KDF); err != nil {
		// The manifest is already replaced but the credentials are not, so
		// the old keys still log in. The client answers a 500 by retrying
		// the rekey under the new ETag, which is idempotent. The same retry
		// repairs the other way this state arises: a crash between the two
		// renames.
		s.log.Error("rekey: manifest replaced but credentials not rotated", "error", err)
		writeError(w, http.StatusInternalServerError, codeInternal)
		return
	}
	s.sessions.RevokeOthers(sessionToken(r))
	s.log.Info("credentials rotated", "remote", clientIP(r))
	w.Header().Set("ETag", etag)
	writeJSON(w, http.StatusOK, struct {
		ETag string `json:"etag"`
	}{ETag: etag})
}

// handlePutSessionKey stores the server half of the client's split session
// key on the current session, replacing any previous one. It lives only in
// memory and goes with the session.
func (s *Server) handlePutSessionKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key string `json:"key"`
	}
	if !readJSON(w, r, maxCredentialBody, &req) {
		return
	}
	key, err := base64.StdEncoding.DecodeString(req.Key)
	if err != nil || len(key) != auth.SessionKeyLen {
		writeError(w, http.StatusBadRequest, codeInvalidSessKey)
		return
	}
	if !s.sessions.SetKey(sessionToken(r), key) {
		// The session expired between requireSession and here.
		writeError(w, http.StatusUnauthorized, codeUnauthorized)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleGetSessionKey returns the current session's key, if one was set.
func (s *Server) handleGetSessionKey(w http.ResponseWriter, r *http.Request) {
	key, ok := s.sessions.Key(sessionToken(r))
	if !ok {
		writeError(w, http.StatusNotFound, codeNotFound)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Key string `json:"key"`
	}{Key: base64.StdEncoding.EncodeToString(key)})
}

// sessionToken returns the session cookie of a request that requireSession
// has already admitted. A missing cookie yields "", which no session matches.
func sessionToken(r *http.Request) string {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return ""
	}
	return c.Value
}

// handleGetManifest returns the encrypted manifest and its ETag.
func (s *Server) handleGetManifest(w http.ResponseWriter, r *http.Request) {
	data, etag, err := s.store.Manifest(r.Context())
	switch {
	case err == nil:
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, codeNotFound)
		return
	default:
		s.fail(w, r, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", contentTypeOctet)
	h.Set("Content-Length", strconv.Itoa(len(data)))
	h.Set("ETag", etag)
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(data); err != nil {
		s.log.Debug("manifest write failed", "error", err)
	}
}

// handlePutManifest replaces the manifest under an If-Match precondition, so
// two devices cannot silently overwrite each other's segment list.
func (s *Server) handlePutManifest(w http.ResponseWriter, r *http.Request) {
	data, ok := readBody(w, r, s.cfg.MaxManifestBytes)
	if !ok {
		return
	}
	ifMatch := strings.TrimSpace(r.Header.Get("If-Match"))
	etag, err := s.store.PutManifest(r.Context(), data, ifMatch)
	switch {
	case err == nil:
	case errors.Is(err, store.ErrIfMatchRequired):
		writeError(w, http.StatusPreconditionRequired, codeIfMatchRequired)
		return
	case errors.Is(err, store.ErrManifestConflict):
		writeError(w, http.StatusPreconditionFailed, codeConflict)
		return
	default:
		s.fail(w, r, err)
		return
	}
	w.Header().Set("ETag", etag)
	writeJSON(w, http.StatusOK, struct {
		ETag string `json:"etag"`
	}{ETag: etag})
}

// handleGetBlob streams a blob. It also answers HEAD, where it reports the
// size without reading the file.
func (s *Server) handleGetBlob(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !store.ValidID(id) {
		writeError(w, http.StatusBadRequest, codeInvalidID)
		return
	}
	rc, size, err := s.store.Get(r.Context(), id)
	switch {
	case err == nil:
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, codeNotFound)
		return
	default:
		s.fail(w, r, err)
		return
	}
	defer func() { _ = rc.Close() }()

	h := w.Header()
	h.Set("Content-Type", contentTypeOctet)
	h.Set("Content-Length", strconv.FormatInt(size, 10))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	if _, err := io.Copy(w, rc); err != nil {
		s.log.Debug("blob write failed", "id", id, "error", err)
	}
}

// handlePutBlob stores a new blob. Blobs are write-once: a repeated id is a
// conflict whatever the body contains, because every blob carries a random
// nonce and two encryptions of the same message never match byte for byte.
func (s *Server) handlePutBlob(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !store.ValidID(id) {
		writeError(w, http.StatusBadRequest, codeInvalidID)
		return
	}
	body := http.MaxBytesReader(w, r.Body, s.cfg.MaxBlobBytes)
	switch err := s.store.Put(r.Context(), id, body); {
	case err == nil:
	case errors.Is(err, store.ErrExists):
		writeError(w, http.StatusConflict, codeExists)
		return
	case tooLarge(err):
		writeError(w, http.StatusRequestEntityTooLarge, codeTooLarge)
		return
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		// The client hung up mid-upload and nothing was stored. Nobody will
		// read this answer, but writing it keeps the request log from
		// recording net/http's implicit 200.
		s.log.Debug("blob upload aborted", "id", id, "error", err)
		writeError(w, http.StatusRequestTimeout, codeBadRequest)
		return
	default:
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
}

// handleBlobsExist reports which of the given ids are already stored, so an
// interrupted import can skip re-uploading them.
func (s *Server) handleBlobsExist(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs []string `json:"ids"`
	}
	// Each id is 64 characters plus JSON quoting and a separator. The slack
	// keeps a batch that is only slightly over the limit an explicit
	// too_many_ids answer rather than an opaque 413.
	limit := int64(s.cfg.MaxExistsIDs+16)*(store.IDLen+4) + 64
	if !readJSON(w, r, limit, &req) {
		return
	}
	if len(req.IDs) > s.cfg.MaxExistsIDs {
		writeError(w, http.StatusBadRequest, codeTooManyIDs)
		return
	}
	for _, id := range req.IDs {
		if !store.ValidID(id) {
			writeError(w, http.StatusBadRequest, codeInvalidID)
			return
		}
	}
	found := make([]string, 0, len(req.IDs))
	for _, id := range req.IDs {
		ok, err := s.store.Exists(r.Context(), id)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		if ok {
			found = append(found, id)
		}
	}
	writeJSON(w, http.StatusOK, struct {
		Exists []string `json:"exists"`
	}{Exists: found})
}

// handleListBlobs returns every stored id, for client-side garbage collection.
func (s *Server) handleListBlobs(w http.ResponseWriter, r *http.Request) {
	ids := make([]string, 0)
	if err := s.store.List(r.Context(), func(id string) error {
		ids = append(ids, id)
		return nil
	}); err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		IDs []string `json:"ids"`
	}{IDs: ids})
}

func (s *Server) setSessionCookie(w http.ResponseWriter, token string) {
	//nolint:gosec // Secure is config-driven: false only for a plain-HTTP LAN
	// deployment, where the flag would stop the cookie from ever being sent.
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		// Strict is enough for a single-origin app and blocks the cookie from
		// riding along with any cross-site request at all.
		SameSite: http.SameSiteStrictMode,
		Secure:   s.cfg.Secure,
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	//nolint:gosec // see setSessionCookie
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   s.cfg.Secure,
	})
}

// readJSON decodes a size-limited JSON body, answering the client itself when
// the body is malformed or too large.
func readJSON(w http.ResponseWriter, r *http.Request, limit int64, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		if tooLarge(err) {
			writeError(w, http.StatusRequestEntityTooLarge, codeTooLarge)
		} else {
			writeError(w, http.StatusBadRequest, codeBadRequest)
		}
		return false
	}
	return true
}

// readBody reads a size-limited raw body, answering the client itself on error.
func readBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, bool) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		if tooLarge(err) {
			writeError(w, http.StatusRequestEntityTooLarge, codeTooLarge)
		} else {
			writeError(w, http.StatusBadRequest, codeBadRequest)
		}
		return nil, false
	}
	return data, true
}

// fail logs an unexpected error and answers with a bare 500: error details
// stay in the server log.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	s.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "error", err)
	writeError(w, http.StatusInternalServerError, codeInternal)
}

func tooLarge(err error) bool {
	var maxErr *http.MaxBytesError
	return errors.As(err, &maxErr)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, struct {
		Error string `json:"error"`
	}{Error: code})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		body, status = []byte(`{"error":"`+codeInternal+`"}`), http.StatusInternalServerError
	}
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
