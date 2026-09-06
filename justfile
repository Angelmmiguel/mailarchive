# Development commands. Run them inside the Nix shell (`nix develop`, or let
# direnv load it for you).

# Private overrides such as MAILARCHIVE_ADDR live in .env.local (gitignored).
# just loads it on every run, so a change takes effect without re-entering the
# shell; variables already set in the environment win.
set dotenv-load := true
set dotenv-filename := ".env.local"

default: test

# Run the server against ./data.
serve *args:
    go run ./cmd/mailarchive serve --data ./data {{args}}

# Run the Go server and the Vite dev server together, until Ctrl-C.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    just serve &
    just web-dev &
    trap 'kill 0' EXIT INT TERM
    wait -n

# Run the Go and web test suites.
test: web-test
    go test -race ./...

# Vet and lint everything.
lint: web-check
    go vet ./...
    golangci-lint run

# Build the binary into bin/, with the web app embedded.
build: web-build
    go build -o bin/mailarchive ./cmd/mailarchive

# Report files that gofmt would change.
fmt:
    gofmt -l .

# Web

# Install the web app's dependencies exactly as the lockfile pins them.
[working-directory('web')]
web-install:
    pnpm install --frozen-lockfile

# Serve the app on :5173, proxying /api to the Go server (MAILARCHIVE_ADDR, default :8080).
[working-directory('web')]
web-dev:
    pnpm dev

# Type-check, lint and check the formatting of the web app.
[working-directory('web')]
web-check:
    pnpm check
    pnpm lint

# Run the web test suite.
[working-directory('web')]
web-test:
    pnpm test

# End-to-end account flows against a throwaway Go server on 127.0.0.1:18100.
# The binary is built first so that the server, not `go run`, is what gets
# killed on exit and the health poll never waits on the compiler. The login
# rate limit is raised so the scenario never waits for a window to pass.
web-e2e:
    #!/usr/bin/env bash
    set -euo pipefail
    tmp=$(mktemp -d)
    trap '[ -n "${server:-}" ] && kill "$server"; rm -rf "$tmp"' EXIT
    go build -o "$tmp/mailarchive" ./cmd/mailarchive
    "$tmp/mailarchive" serve --addr 127.0.0.1:18100 --data "$tmp/data" --login-attempts 1000 &
    server=$!
    for i in $(seq 1 50); do curl -sf 127.0.0.1:18100/api/health >/dev/null && break; sleep 0.2; done
    cd web && MAILARCHIVE_E2E=http://127.0.0.1:18100 pnpm vitest run src/lib/account/e2e.test.ts

# Compile the app into web/build, where the Go binary embeds it from. The
# build script recreates build/.gitkeep afterwards: adapter-static wipes the
# directory, and the Go embed needs the placeholder present on a clean
# checkout.
[working-directory('web')]
web-build:
    pnpm build
