# mailarchive

Store old emails securely and clear your inbox.

mailarchive is a self-hosted, zero-knowledge email archive. Export your old
mail as `.eml` files, drop them into the web app, and browse them from any
device. Everything is encrypted in your browser before it reaches the server,
so the machine hosting the archive never sees a single plaintext message.

## Features

**v1**

- Import `.eml` dumps from the browser, no local tooling required
- Zero-knowledge storage: parsing, encryption, indexing and search all happen
  client-side
- Byte-exact originals kept for export, plus a fast pre-rendered view per message
- Threaded, responsive reading experience built for exploring years of mail
- Full-text search over subjects, senders and bodies, plus filters by date,
  labels and attachments, all running locally
- Encrypted local cache so unlocking on a known device is instant
- Derived labels: `sent` from your configured addresses, `attachments`, threads
- Re-importing the same dump never creates duplicates
- One passphrase plus a one-time recovery key, no server-side reset
- Multi-device: any browser with the URL and passphrase can read and import
- Single Go binary serving both the API and the web app, storing plain files on
  disk that back up with a copy

**Planned**

- User-defined labels and notes
- Garbage collection of orphaned blobs

## How it works

The Go server is a dumb encrypted blob store. The SvelteKit web app derives
your keys from a passphrase, encrypts each message together with an index of
its metadata and search terms, and uploads them. On reading, it downloads the
encrypted index once, caches it encrypted on the device, and searches it in
memory. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Development

The toolchain is a Nix flake. Enter it with `nix develop` (or direnv), then:

```bash
just web-install   # pnpm install, once
just dev           # Go server on :8080 and the Vite dev server on :5173
just test          # go test -race and vitest
just lint          # go vet, golangci-lint, svelte-check, eslint, prettier
just build         # build the web app and a Go binary that embeds it
```

Open http://localhost:5173 during development. Vite proxies `/api` to the Go
server, so the browser sees a single origin, exactly as in production where
the Go binary serves both. `just build` writes `bin/mailarchive`.

If port 8080 is taken, put `MAILARCHIVE_ADDR=:8090` (any free port) in a
`.env.local` file at the repo root. The Nix shell loads it, and both the Go
server and the Vite proxy read the same variable.

## Deployment

The image is [`ghcr.io/angelmmiguel/mailarchive`](https://github.com/Angelmmiguel/mailarchive/pkgs/container/mailarchive),
published by [.github/workflows/image.yml](.github/workflows/image.yml): every
push to `main` updates `latest`, and a `v*` tag adds the version tags.
`just image` builds the same image locally. It runs the binary from scratch
as `nobody:users` (99:100) with the archive at `/data` and the app on port
8080:

```bash
mkdir -p data && chown 99:100 data
docker run -d --name mailarchive -p 8989:8080 -v "$PWD/data:/data" ghcr.io/angelmmiguel/mailarchive
```

The host directory must belong to uid 99, because the archive is written
0700/0600. The server speaks plain HTTP; put a reverse proxy in front of it
for TLS, and then set two variables: `MAILARCHIVE_SECURE=true`, which marks
the session cookie Secure (leave it off on a plain-HTTP LAN, where it would
stop the cookie from being sent), and `MAILARCHIVE_TRUSTED_PROXIES` with the
proxy's address or CIDR range, so that the login rate limit counts per client
rather than per proxy. Without the second, every visitor behind the proxy
shares one budget of attempts.

Run outside Docker, the binary listens on `127.0.0.1:8080` unless `--addr`
or `MAILARCHIVE_ADDR` says otherwise (`:8080` for every interface); an
archive that has not been set up belongs to whoever reaches it first, so it
should not be reachable by strangers until it has been. The image listens
on every interface of the container, as a container must.

**Unraid.** [unraid/mailarchive.xml](unraid/mailarchive.xml) is a Docker
template with the port, archive path and the variables above. Copy it to
`/boot/config/plugins/dockerMan/templates-user/` and it appears in the
template dropdown of *Docker → Add Container*, or add this repository under
*Apps → Settings → Template Repositories*. Unraid creates the appdata path
owned by `nobody:users`, which is what the container runs as.

## Status

Early. The Go server, the SvelteKit scaffolding and their test suites are in
place. No archive functionality exists yet.

## License

MIT, see [LICENSE](LICENSE).
