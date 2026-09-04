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

## Status

Early design phase. Nothing runs yet.

## License

MIT, see [LICENSE](LICENSE).
