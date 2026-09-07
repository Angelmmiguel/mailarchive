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
- **Frontend:** SvelteKit SPA in `web/`, compiled by adapter-static into
  `web/build`, which the Go binary embeds and serves. In development Vite
  proxies `/api` to the Go server, so there is no CORS. Svelte 5 only: runes
  (`$state`, `$derived`, `$effect`, `$props`) everywhere, never the legacy
  `export let` or `$:` syntax, and never `svelte/store`. Shared reactive state
  lives in `.svelte.ts` modules under `src/lib/state`, exported as class
  instances or objects whose properties are `$state`. The API client in
  `src/lib/api` mirrors the Go routes one to one and knows nothing about
  crypto. Visual language comes from `src/lib/styles/tokens.css` (primitives
  and a semantic layer; a theme overrides only the semantic layer) and the
  component library in `src/lib/components`: components draw the styleguide
  and own their own interactions, routes are glue that composes them and
  calls the account layer, never business logic of their own. When unsure
  about Svelte 5 idioms, check https://svelte.dev/docs.
  The Content-Security-Policy is authored in `svelte.config.js` and delivered
  as a header by the Go handler, which reads it from the built `index.html`.
- **Toolchain:** Nix flake. Run commands inside `nix develop` (or direnv).

## Commands

```
just test    # go test -race ./... and vitest
just lint    # go vet, golangci-lint, svelte-check, eslint, prettier
just dev     # Go server on :8080 and Vite on :5173 together
just build   # pnpm build, then go build with the web app embedded
just web-e2e # account flows and the Playwright specs against throwaway servers
```

`just test` and `just lint` must be clean before work is considered done,
along with `gofmt -l .` printing nothing; run `just web-e2e` when a change
touches a screen or an account flow. Browser specs live in `web/tests/e2e`,
one file per scenario that needs a never-set-up server, with synthetic `.eml`
fixtures in `web/tests/fixtures` (never real mail); the browsers come from
the flake, so `@playwright/test` must match `playwright-driver` in nixpkgs.
Web-only variants exist as `web-install`, `web-dev`, `web-check`, `web-test` and `web-build`.

## Conventions

- Security first. Validate ids before touching the filesystem, compare secrets
  in constant time, never log tokens, keys or bodies, keep writes atomic.
- Concise, idiomatic Go. Doc comments on exported identifiers; other comments
  only where the *why* is non-obvious. No narration comments, no abstractions
  with a single caller, no utils packages.
- Sentinel errors live in the package that owns the concept; wrap with `%w`.
- Every route and every store operation has tests, run with the race detector.
- Do not commit without an explicit request.
