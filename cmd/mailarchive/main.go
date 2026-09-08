// Command mailarchive serves the mailarchive API and web app from a single
// binary and a single data directory.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Angelmmiguel/mailarchive/internal/auth"
	"github.com/Angelmmiguel/mailarchive/internal/server"
	"github.com/Angelmmiguel/mailarchive/internal/store"
	"github.com/Angelmmiguel/mailarchive/web"
)

const shutdownTimeout = 10 * time.Second

func main() {
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		usage()
		os.Exit(2)
	}
	if err := serve(os.Args[2:]); err != nil {
		fmt.Fprintln(os.Stderr, "mailarchive:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `mailarchive serves a zero-knowledge encrypted mail archive.

usage:
  mailarchive serve [flags]

flags:
  --addr             listen address (env MAILARCHIVE_ADDR, default
                     127.0.0.1:8080); use :8080 to listen on every interface
  --data             data directory (env MAILARCHIVE_DATA, default ./data)
  --login-attempts   login, setup and rekey attempts allowed per address and
                     minute (env MAILARCHIVE_LOGIN_ATTEMPTS, default 10)
  --secure           mark the session cookie Secure; use it behind HTTPS
                     (env MAILARCHIVE_SECURE). The server itself speaks plain
                     HTTP; TLS is the reverse proxy's job.
  --trusted-proxies  comma-separated addresses or CIDR ranges of the reverse
                     proxy, whose X-Forwarded-For then names the client for
                     rate limiting (env MAILARCHIVE_TRUSTED_PROXIES)
`)
}

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	fs.Usage = usage
	addr := fs.String("addr", env("MAILARCHIVE_ADDR", "127.0.0.1:8080"), "listen address")
	dataDir := fs.String("data", env("MAILARCHIVE_DATA", "./data"), "data directory")
	loginAttempts := fs.Int("login-attempts", envInt("MAILARCHIVE_LOGIN_ATTEMPTS", auth.DefaultLoginAttempts), "login attempts per address and minute")
	secure := fs.Bool("secure", envBool("MAILARCHIVE_SECURE"), "mark the session cookie Secure")
	proxies := fs.String("trusted-proxies", os.Getenv("MAILARCHIVE_TRUSTED_PROXIES"), "reverse proxy addresses or CIDR ranges")
	if err := fs.Parse(args); err != nil {
		return err
	}
	trusted, err := parsePrefixes(*proxies)
	if err != nil {
		return fmt.Errorf("--trusted-proxies: %w", err)
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	st, err := store.NewFS(*dataDir)
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()
	creds, err := auth.LoadCredentials(filepath.Join(*dataDir, "auth.json"))
	if err != nil {
		return err
	}
	// A rekey the last run did not finish is settled against the manifest
	// on disk before anyone can log in.
	_, etag, err := st.Manifest(context.Background())
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if installed, err := creds.RecoverRotation(etag); err != nil {
		return err
	} else if installed {
		log.Warn("finished a credentials rotation interrupted by the last shutdown")
	}
	srv := server.New(server.Config{
		Secure:         *secure,
		TrustedProxies: trusted,
		UI:             web.Handler(),
		Logger:         log,
	}, st, creds, auth.NewSessionStore(auth.DefaultSessionTTL, auth.DefaultSessionMaxAge),
		auth.NewRateLimiter(*loginAttempts, auth.DefaultLoginWindow))

	if !*secure {
		log.Warn("session cookie is not marked Secure; run behind HTTPS with --secure outside a trusted LAN")
	}
	if !creds.IsSetup() {
		log.Warn("archive is not set up; the first account created through the web app will own it")
	}

	httpSrv := &http.Server{
		Addr:    *addr,
		Handler: srv,
		// Bound the time a connection may hold the server hostage before it
		// has sent a complete request head; the handlers bound the body. There
		// is deliberately no WriteTimeout: blob downloads are large and slow
		// links are normal.
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", *addr, "data", *dataDir)
		errc <- httpSrv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("listen: %w", err)
		}
		return nil
	case <-ctx.Done():
		log.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := httpSrv.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shutdown: %w", err)
		}
		return nil
	}
}

// parsePrefixes reads a comma-separated list of addresses and CIDR ranges;
// a bare address stands for itself alone.
func parsePrefixes(list string) ([]netip.Prefix, error) {
	var prefixes []netip.Prefix
	for _, item := range strings.Split(list, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if p, err := netip.ParsePrefix(item); err == nil {
			prefixes = append(prefixes, p.Masked())
			continue
		}
		a, err := netip.ParseAddr(item)
		if err != nil {
			return nil, fmt.Errorf("%q is neither an address nor a CIDR range", item)
		}
		prefixes = append(prefixes, netip.PrefixFrom(a, a.BitLen()))
	}
	return prefixes, nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// envInt falls back when the variable is unset or not a number; a value out
// of range is NewRateLimiter's to correct.
func envInt(key string, fallback int) int {
	if n, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return n
	}
	return fallback
}

// envBool is true only for a value strconv.ParseBool accepts as true; unset
// or malformed means false, so a typo never marks a plain-HTTP cookie Secure
// and locks the user out.
func envBool(key string) bool {
	b, err := strconv.ParseBool(os.Getenv(key))
	return err == nil && b
}
