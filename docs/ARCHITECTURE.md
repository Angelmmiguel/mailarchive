# Architecture

mailarchive is a zero-knowledge, offline email archive. You upload `.eml` files
through the web app, they are encrypted in your browser, and the server only
ever stores ciphertext. Reading, searching and importing all happen client-side.

## Principles

- **Zero knowledge.** The server never sees plaintext or keys. It stores opaque
  blobs and serves static assets. A full server compromise yields ciphertext,
  blob sizes and upload timing, nothing that reconstructs a message, a subject,
  a sender or a search term.
- **Browser does the work.** Parsing, indexing, encryption and decryption run in
  the web app (Web Workers). There is no trusted local CLI.
- **Append-only, deduplicated.** Every import produces an immutable segment.
  Nothing is rewritten in place, and a message already in the archive is never
  indexed or uploaded twice.
- **Single bundle.** One Go binary serves the API and the compiled SvelteKit SPA.
- **Single user, single archive, single passphrase.** No multi-tenancy in v1.

## Components

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ Web app (SvelteKit SPA)      │  HTTPS │ Server (Go)                  │
│                              │ ─────► │                              │
│ • unlock: passphrase → keys  │        │ • serves the SPA             │
│ • import: parse .eml, index, │        │ • auth (derived auth key)    │
│   encrypt, upload            │        │ • blob store: GET/PUT/HEAD   │
│ • read: fetch, decrypt,      │        │ • manifest with ETag         │
│   render, search             │        │ • files on the NAS disk      │
│ • encrypted local cache      │        │                              │
└──────────────────────────────┘        └──────────────────────────────┘
```

The server has no knowledge of what a "message" is. Its whole API is a
key-value store of encrypted blobs plus one mutable, versioned manifest.

## Storage layout

All values are encrypted with the archive keys described below. Names are
opaque ids that the server cannot relate to any plaintext.

```
manifest                      versioned, ETag-protected. Wrapped keys, settings,
                              list of segments, schema version.
segments/<seg>/index          message metadata for one import run
segments/<seg>/terms/<shard>  inverted-index shards for full-text search
blobs/<id>                    raw .eml or message view
```

### Blob kinds

Each message produces two blobs:

| kind | content                                                       | fetched when              |
|------|---------------------------------------------------------------|---------------------------|
| raw  | original `.eml`, byte-exact, zstd-compressed                   | export, attachment download, view source |
| view | parsed headers, text body, sanitized HTML, attachment metadata | opening a message         |

The raw blob is the archival truth. The view blob is derived and can be
regenerated from raw by any client that holds the key. Attachments are not
stored separately: downloading one fetches the raw blob, decrypts it in the
browser and extracts the MIME part. This keeps storage at roughly the size of
the original dump at the cost of a larger download per attachment.

### Segment index

One record per message, a few hundred bytes each: message id, date, from, to,
cc, subject, snippet, thread id, labels, size, attachment list (name, type,
size, MIME part path), and pointers to the raw and view blobs.

### Term shards

The full-text index for a segment. At import, the worker tokenizes subject,
sender and recipient names, and the text body (HTML stripped). Tokens are
lowercased Unicode words, no stemming in v1; prefix matching covers most of
what stemming would. Each shard holds `term → [(message id, field, frequency)]`
for the terms that fall into it.

Terms are assigned to shards by the first characters of the term, but the
shard *name* on the server is an HMAC of that prefix under the id key. The
server sees N opaque files of varying size per segment, nothing more.

### Labels

The `.eml` dump carries no folder structure, so labels are derived at import:

- `sent` when the `From` address matches one of the configured own addresses
- `attachments` when the message has at least one non-inline part
- thread grouping from `Message-ID`, `In-Reply-To` and `References`

Own addresses live in the encrypted manifest settings. User-defined labels are
a later addition and would live in a small mutable, encrypted "annotations"
document rather than in the immutable segments.

## Cryptography

Key hierarchy, all derived and held in the browser:

```
passphrase ──Argon2id──► KEK (passphrase)  ─┐
                                            ├──wraps──► DEK (random 256-bit)
recovery key (random, shown once) ──────────┘              │
                                                           ├─► blob encryption key
passphrase ──Argon2id, separate salt──► auth key           ├─► id (HMAC) key
                                        (sent to server)   └─► local cache key
```

- **DEK** is random and is what actually protects the archive. It is wrapped
  twice, once by the passphrase KEK and once by the recovery key. Changing the
  passphrase rewraps the DEK; nothing else is re-encrypted.
- **Recovery key** is a random 256-bit value shown once at setup, for the user
  to store offline. Losing both passphrase and recovery key loses the archive.
  There is no server-side reset by design.
- **Auth key** is derived from the same passphrase with a different salt and
  domain tag. The server stores only a hash of it. One passphrase, and the
  server still never learns the encryption keys.
- **Blob encryption** is XChaCha20-Poly1305 with a random nonce per blob. The
  blob id is passed as additional authenticated data so the server cannot swap
  one blob for another. Segment indexes, term shards and the manifest are
  encrypted the same way.
- **Ids** are `HMAC-SHA256(id key, SHA-256(plaintext))` for blobs and
  `HMAC-SHA256(id key, prefix)` for term shards. Deterministic, so identical
  messages deduplicate, but meaningless without the id key.
- **Cache key** encrypts the local IndexedDB cache. It derives from the DEK, so
  the cache is unreadable without unlocking and becomes useless if the
  archive keys are ever rotated.
- Salts, Argon2 parameters and the wrapped DEKs live in the manifest.

Known leakage to the server: number and sizes of blobs, segments and shards,
and upload timing. Because the client fetches all shards once and caches them,
searches produce no server traffic and leak nothing at query time. Padding
sizes to fixed buckets is a cheap future hardening.

## Import pipeline (browser)

1. User selects `.eml` files or a folder. Files are streamed one at a time
   through a Web Worker, never held all in memory.
2. Each file is parsed (MIME, headers, parts). Own-address matching, threading,
   snippet extraction and tokenization run here.
3. Compute the message id from the raw bytes. **Dedup runs against the merged
   index already in memory**, not against blob existence: if the id is known,
   the message is skipped entirely and produces no new index record. The
   reader additionally collapses records sharing a `Message-ID` header, which
   covers a provider re-export that altered transport headers.
4. For messages that are new, ask the server which blob ids already exist and
   skip uploading those bytes. This is only an optimization for recovering
   from a previously interrupted import.
5. Encrypt and upload the raw and view blobs.
6. When the batch finishes, encrypt and upload the segment index and its term
   shards, then update the manifest with `If-Match` on its ETag. If another
   device changed the manifest meanwhile, refetch, merge the segment list,
   retry.

A batch that fails mid-way leaves orphan blobs but no dangling segment. Orphans
are harmless and can be garbage-collected later by a client-side job that
compares the manifest against the server listing.

## Reading, cache and search

1. Unlock: derive keys, open the local encrypted cache. If it holds a merged
   index and term shards, decrypt them into memory and render immediately.
2. Fetch the manifest. For any segment not yet in the cache, fetch its index
   and shards, decrypt, merge into memory, and write the merged result back to
   the cache encrypted under the cache key.
3. List and thread views render from memory. Opening a message fetches and
   decrypts its view blob. View and raw blobs are also cached as ciphertext.
4. Search runs entirely in memory: metadata filters (sender, recipient,
   subject, date range, labels, has-attachment) combined with full-text lookup
   in the merged term index, ranked by term frequency and recency.
5. Lock clears memory. The encrypted cache stays on disk and is useless
   without the passphrase.

Any browser with the URL and passphrase gets the same experience. First unlock
on a new device pays one download of the index and shards, later unlocks are
instant.

## Server API

Deliberately small. All routes except the SPA and login require a session.

```
POST   /api/login                     auth key → session cookie
GET    /api/manifest                  returns ciphertext + ETag
PUT    /api/manifest                  If-Match required
HEAD   /api/blobs/<id>                existence check
GET    /api/blobs/<id>
PUT    /api/blobs/<id>                write-once; 409 if exists with different content
POST   /api/blobs/exists              batch existence check, list of ids
GET    /api/blobs                     listing, for garbage collection
```

Storage is a directory on the NAS filesystem, one file per blob, so a backup
is a plain copy.

## Out of scope for v1

- IMAP or any live sync with a provider
- Multiple users or archives
- User-defined labels and notes
- Attachment content extraction (PDF text, etc.)
- Garbage collection of orphaned blobs
