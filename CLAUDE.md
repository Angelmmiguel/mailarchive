# mailarchive

Zero-knowledge, self-hosted email archive. The server stores ciphertext only;
the browser parses, encrypts, indexes and searches.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the design reference: consult
it when a task touches storage layout, crypto, the API contract or the
import/search pipeline, and update it in the same change when you alter any of
those. Routine work does not need it.

## Stack

- **Backend:** Go, standard library only. No web framework and no third-party
  modules; `net/http`'s mux, `log/slog` and `crypto/*` cover everything the API
  needs, and a security-focused server should not carry dependencies in its
  request path. Revisit only if the API grows well past its current size.
- **Frontend:** SvelteKit SPA compiled to static assets under `web/build`, which
  the Go binary embeds and serves. In development Vite proxies `/api` to the Go
  server, so there is no CORS.
- **Toolchain:** Nix flake. Run commands inside `nix develop` (or direnv).

## Commands

```
just test    # go test -race ./...
just lint    # go vet + golangci-lint
just serve   # go run ./cmd/mailarchive serve --data ./data
```

All three must be clean before work is considered done, along with `gofmt -l .`
printing nothing.

## Conventions

- Security first. Validate ids before touching the filesystem, compare secrets
  in constant time, never log tokens, keys or bodies, keep writes atomic.
- Concise, idiomatic Go. Doc comments on exported identifiers; other comments
  only where the *why* is non-obvious. No narration comments, no abstractions
  with a single caller, no utils packages.
- Sentinel errors live in the package that owns the concept; wrap with `%w`.
- Every route and every store operation has tests, run with the race detector.
- Do not commit without an explicit request.
