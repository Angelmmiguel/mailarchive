# Architecture

mailarchive is a zero-knowledge, offline email archive. You upload `.eml` files
through the web app, they are encrypted in your browser, and the server only
ever stores ciphertext. Reading, searching and importing all happen client-side.

## Principles

- **Zero knowledge.** The server never sees plaintext or keys. It stores opaque
  blobs and serves static assets. A copy of its storage, or a compromise of
  the server that leaves the client it serves untouched, yields ciphertext,
  blob sizes and upload timing, nothing that reconstructs a message, a
  subject, a sender or a search term. The guarantee stops there: the same
  server delivers the JavaScript that takes the passphrase, and a server
  that has been made to serve a different client can obtain whatever that
  client sees. The CSP does not defend against the origin itself.
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

The web app is a pure SPA built with adapter-static into `web/build`, which
the Go binary embeds. Its Content-Security-Policy is authored in
`svelte.config.js`, where the build can hash its own inline bootstrap script;
the Go handler reads the resulting meta tag out of `index.html` and delivers
it as a header, adding `frame-ancestors 'none'`. In development Vite serves
the app and proxies `/api` to the Go server, so the browser always talks to a
single origin and the same-origin checks behave as in production.

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

This is the client's logical view. On the server there is exactly one flat
namespace of write-once blobs plus the manifest: a segment index and a term
shard are blobs like any other, and the manifest is what says which blob plays
which role. Keeping the server this ignorant is what makes it small.

### Blob kinds

Each message produces two blobs:

| kind | content                                                       | fetched when              |
|------|---------------------------------------------------------------|---------------------------|
| raw  | original `.eml`, byte-exact, gzip-compressed                   | export, attachment download, view source |
| view | parsed headers, text body, HTML as sent, attachment metadata   | opening a message         |

The raw blob is the archival truth. The view blob is derived and can be
regenerated from raw by any client that holds the key. Both are gzip-compressed
before sealing, through the browser's native streams (zstd would need a WASM
dependency for no gain the server could see). The HTML in the view is stored as
the sender wrote it and sanitized where it is rendered, so a stricter sanitizer
later applies to old messages too. Attachments are not
stored separately: downloading one fetches the raw blob, decrypts it in the
browser and extracts the MIME part. This keeps storage at roughly the size of
the original dump at the cost of a larger download per attachment.

### Segment index

One record per message, a few hundred bytes each: message id, date, from, to,
cc, subject, snippet, thread id, size, attachment list (name, type, size, part
index), and pointers to the raw and view blobs. The manifest entry for a
segment lists the ids of its term shards, since the server cannot relate a
shard to its segment.

A record holds only what the message itself says. Segments are immutable and
a re-import of the same message is skipped as a duplicate, so anything written
into a record is frozen at import: a value that also depends on a setting
would keep answering for the setting as it was that day, and the only way to
correct it would be to rebuild the archive. Whatever follows from a setting,
or from another message, is worked out from the records when they are read.

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

The `.eml` dump carries no folder structure, so labels are derived from the
records, at grouping and search time rather than at import:

- `sent` when the `From` address matches one of the configured own addresses;
  an own address may hold `*` for any run of characters, so `*@icloud.com`
  covers the aliases a relay such as Hide My Email hands out
- `attachments` when the message has at least one non-inline part

Own addresses live in the encrypted manifest settings, so adding one later
(an alias, a forgotten work address) relabels every message the moment the
setting is saved. Thread grouping is the one thing decided at import, since
it depends on the messages known at the time: by `Message-ID`, `In-Reply-To`
and `References`, and, for a message whose ancestors are all unknown (a sent
folder exported without those headers), by subject stripped of reply
prefixes, shared correspondent and a ninety-day window; a message that is
not itself a reply joins only a thread that already holds one. User-defined labels are a later addition and
would live in a small mutable, encrypted "annotations" document rather than
in the immutable segments.

## Cryptography

Key hierarchy, all derived and held in the browser. HKDF labels are the
literal strings shown; every key is 32 bytes.

```
passphrase, NFKC-normalised
  └─ Argon2id(salt, m=64 MiB, t=3, p=1) ─► root
       ├─ HKDF(root, "mailarchive/kek/v1")  ─► KEK            never leaves the browser
       └─ HKDF(root, "mailarchive/auth/v1") ─► auth key       sent to the server

recovery key, 32 random bytes, shown once as 24 BIP39 words
  ├─ HKDF(rk, "mailarchive/kek/v1")  ─► recovery KEK
  └─ HKDF(rk, "mailarchive/auth/v1") ─► recovery auth key     sent to the server

DEK, 32 random bytes, protects the whole archive
  ├─ wrapped under KEK            AAD "mailarchive/dek/passphrase/v1"
  ├─ wrapped under recovery KEK   AAD "mailarchive/dek/recovery/v1"
  ├─ wrapped under session key    AAD "mailarchive/dek/session/v1", see below
  ├─ HKDF(dek, "mailarchive/blob/v1")     ─► blob key
  ├─ HKDF(dek, "mailarchive/id/v1")       ─► id (HMAC) key
  ├─ HKDF(dek, "mailarchive/manifest/v1") ─► manifest body key
  └─ HKDF(dek, "mailarchive/cache/v1")    ─► local cache key
```

- **Argon2id** is the one deliberately slow step, run once per unlock in a
  Web Worker. The salt is 16 random bytes and is public: it makes precomputed
  tables useless, and on its own gives an attacker nothing to test guesses
  against. The parameters are stored, not hardcoded, so they can be raised
  later through a rekey. The client accepts only `m` between 8192 and
  1048576 KiB, `t` between 1 and 10, `p` of 1 and a 16-byte salt, so a
  hostile server cannot hand back parameters that make guessing cheap.
- **HKDF** splits one strong key into independent purpose-bound keys. It is
  one-way, so a server that learns the auth key learns nothing about the KEK,
  and one key per purpose keeps a flaw in any component from reaching the
  others.
- **DEK** is random and is what actually protects the archive. Changing the
  passphrase or the recovery key rewraps the DEK; nothing else is
  re-encrypted, so a passphrase change is a change of what opens the
  archive, not of the key that encrypts it. Anyone who once held the DEK
  can still read every blob they can get, old or new; there is no
  operation that rotates the DEK and re-encrypts the archive under it.
- **Recovery key** is 32 random bytes generated at setup and shown once as 24
  English words (BIP39 encoding, used only for its checksum and wordlist,
  never for seed derivation). It needs no Argon2id: a random 256-bit key
  cannot be guessed. Its auth key lets a user who lost the passphrase still
  log in and fetch the manifest. Losing both passphrase and recovery key
  loses the archive; there is no server-side reset by design.
- **Auth keys** are 32 bytes sent as standard base64. The server stores only
  their SHA-256 and compares in constant time. A slow hash on the server
  would add nothing: the recovery auth key derives from 256 random bits,
  and the passphrase auth key carries only the passphrase's entropy, which
  Argon2id already prices per guess, at the same price the wrapped DEK in
  the manifest can be tested at offline. Login accepts either the
  passphrase or the recovery auth key.
- **Sealing** is XChaCha20-Poly1305. Wire format: one version byte `0x01`,
  a 24-byte random nonce, then ciphertext with the 16-byte tag. Blobs use
  their id as additional authenticated data so the server cannot serve one
  blob under another id; wrapped DEKs and the manifest body use the AAD
  strings above.
- **Ids** are `HMAC-SHA256(id key, SHA-256(plaintext))` for blobs and
  `HMAC-SHA256(id key, "<segment id>/<prefix>")` for term shards.
  Deterministic, so identical messages deduplicate, but meaningless without
  the id key. A raw blob is named by the original `.eml` bytes even though
  what is sealed under that name is their gzip; a view or index blob is named
  by the compressed bytes it seals.
- **Cache key** encrypts the local IndexedDB cache. It derives from the DEK, so
  the cache is unreadable without unlocking.

### Manifest layout

Two layers, so the wrapped DEKs can be read before the DEK is known:

```
{
  "version": 1,
  "kdf":     { "name": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": "<base64>" },
  "wrapped": { "passphrase": "<base64 sealed DEK>", "recovery": "<base64 sealed DEK>" },
  "body":    "<base64, sealed under the manifest key>"
}

body, once opened: { "settings": { "ownAddresses": [] }, "segments": [] }
```

The KDF parameters are also stored on the server, because unlock needs them
before it can log in (see the API). The manifest copy keeps a backup
self-describing.

The server reads the `kdf` and `wrapped` fields, and only those: setup and
rekey require them to be present, and a session-only `PUT /api/manifest`
must carry them unchanged, so that a stolen cookie can replace the segment
list but never the wrapped keys. Nothing else binds header to body; a
manifest is not versioned beyond its ETag, so a server, a backup restore or
a cookie holder with an older manifest can roll the archive back to it
without the client noticing.

### Keys in the browser

- While unlocked, the usable keys (DEK and its subkeys) exist only in memory
  and are zeroed on lock. The only key material that touches disk is the
  ciphertext described next, whose decryption key is not on that disk.
- **Surviving a page refresh** uses a split session key. The browser generates
  32 random bytes, hands them to the server, which keeps them in memory on the
  session record, and stores the DEK *encrypted* under them in sessionStorage.
  On load, the browser fetches the session key back with its cookie and
  unwraps the DEK without the passphrase. A stolen server holds a session key
  and no ciphertext; a stolen disk holds ciphertext and no session key. Lock,
  logout or session expiry deletes the server half, which turns the stored
  ciphertext into random bytes. The split protects against either half
  alone: a browser profile stolen whole, sealed DEK and a still-valid
  session cookie together, opens the archive until the session ends.
- The DEK itself is never placed in sessionStorage or IndexedDB: browsers
  persist both to disk.
- Randomness comes only from `crypto.getRandomValues`. The app refuses to run
  without it and warns in an insecure context other than localhost.
- Lock zeroes the keys in place, and work still in flight is not trusted
  to notice: sealing under a key of all zeros is refused outright, and
  every path that waits on the network or on decompression checks that
  the session's keys are still the ones it started with before it stores,
  publishes or caches what it got. A lock in one tab is announced on a
  BroadcastChannel so the other tabs drop their keys at once rather than
  at their next refused request, and a manifest poll the server refuses
  locks the tab that made it. Lock waits at most ten seconds for a running
  import to commit what it finished.
- Idle auto-lock is a future setting: a timer that calls lock.

### Libraries

`@noble/hashes` (Argon2id, HKDF, HMAC, SHA-256), `@noble/ciphers`
(XChaCha20-Poly1305), `@scure/base` (base64) and `@scure/bip39` (recovery
words). One audited, dependency-free family, pure JavaScript, so no
WebAssembly and no CSP change. Versions are pinned exactly, installs run with
`--frozen-lockfile`, dependency install scripts are disabled, and pnpm's
minimum release age keeps a freshly published version out for seven days.
Known-answer tests from the RFCs cover our wiring of each primitive.

Known leakage to the server: number and sizes of blobs, segments and shards,
and upload timing. Because the client fetches all shards once and caches them,
searches produce no server traffic and leak nothing at query time. Padding
sizes to fixed buckets is a cheap future hardening.

## Import pipeline (browser)

1. User selects `.eml` files or a folder, or drops either on the page. Files
   go a few at a time through a Web Worker, never held all in memory.
2. Each file is parsed (MIME, headers, parts) by postal-mime, wrapped behind
   the archive's own message type. Snippet extraction, tokenization and
   compression run in the worker; naming, sealing, own-address matching and
   threading on the main thread, which is the only place keys exist.
3. Compute the message id from the raw bytes. **Dedup runs against the merged
   index already in memory**, not against blob existence: if the id is known,
   the message is skipped entirely and produces no new index record. A
   parsed message whose `Message-ID`, `Date` and `From` match a record is
   skipped too, which covers a provider re-export that altered transport
   headers; all three must match because some clients reuse ids. This is
   a judgement: a message that shares all three with one already archived
   but differs in its body, a list copy with a footer say, is treated as
   the same message and its copy is not kept.
4. Encrypt and upload the raw and view blobs. A blob the server already has
   answers 409, which the client treats as stored; that is how an
   interrupted import resumes without a separate existence check.
5. Every few thousand messages, and once more when the run ends, encrypt and
   upload a segment index and its term shards, then update the manifest with
   `If-Match` on its ETag. If another device changed the manifest meanwhile,
   refetch, merge the segment list, retry. Bounding the segment keeps every
   blob well under the server's cap and means a long run cannot lose
   everything at the end.

A run that is cancelled or stopped by a failure still writes a segment for the
messages it finished, so nothing uploaded has to be imported again. A crash
mid-way leaves orphan blobs but no dangling segment. Orphans are harmless and
can be garbage-collected later by a client-side job that compares the manifest
against the server listing.

## Reading, cache and search

1. Unlock: derive keys, fetch the manifest.
2. For every segment it lists, read the segment index from the local cache
   (IndexedDB, keyed by blob id) or, on a miss, from the server and into the
   cache. Decrypt and merge into memory; the list renders as soon as the
   indexes are in. The term shards follow the same path in the background,
   a segment at a time, so a search never sees half a segment; the list
   says "indexing" until they are all in. The cache holds blobs exactly as
   the server does, ciphertext under the blob key, so it needs no key of
   its own: a disk that leaks it leaks what the server already had, and
   an entry can never be stale because blobs are write-once and named by
   content or HMAC. A cached copy that fails to decrypt is dropped and
   fetched again. An import writes its own index and shards into the cache
   as it uploads them. The cache is dropped whole from Settings, never
   pruned; the cache key derived from the DEK stays reserved for derived
   data that is not a server blob.
3. List and thread views render from memory. Opening a message fetches and
   decrypts its view blob; a few dozen opened views are kept in memory until
   lock. View and raw blobs are also cached as ciphertext.
   The address of a thread is `HMAC-SHA256(id key, "thread/<thread id>")`,
   so a reload on `/t/<key>` sends the server an opaque name rather than a
   Message-ID, and the same link works on every device.
   HTML bodies are sanitized at render (DOMPurify, links forced to a new tab
   without referrer, image sources removed, `url()` and its relatives
   stripped from style attributes and elements) and shown in a shadow root
   under the page's CSP, which forbids inline scripts, painted within its
   own box so that nothing in a message can pose as part of the app;
   nothing in a message can make the browser fetch from a third party
   until the user presses "Load images" for the thread in front of them,
   which keeps https and data image sources, in `<img>` and in CSS alike,
   and resolves `cid:` parts from the raw blob. The policy allows https
   images for that one case. Attachments and the original are extracted
   from the raw blob in the browser; an SVG attachment is downloaded rather
   than opened, since as a blob document it would run on the app's origin.
4. Search runs entirely in memory and sends nothing to the server. The
   query is one string: words, "phrases", -exclusions and the operators
   `from:`, `to:`, `subject:`, `has:attachment`, `is:sent`, `after:`
   and `before:`; the chips and the date menu edit that string, and the
   URL carries it as `q` (plus `order`). Words match as prefixes against
   the record's subject, names and snippet, and against the merged term
   index for bodies, so a hit in the subject shows before the shards are
   in. Every part of the query must hold for some message of a thread, not
   necessarily the same one, since the list is threads. With words in the
   query the threads rank by the sum of their best hits (subject above
   names above body, times log frequency, exact term above prefix), ties by
   date; without, or on request, newest or oldest first. Client-side
   navigation keeps `q` in the browser, but a hard reload or a bookmark
   sends it to the server as part of the request line, unlike thread
   addresses, which are HMACs. The server logs paths only; a reverse
   proxy in front must be told not to log query strings. The browser's
   own history, bookmarks and whatever syncs them hold the query and the
   thread subject, which is the page title, in plaintext.
5. While unlocked, the manifest is re-read every minute and when the tab
   regains focus. A changed ETag means another device committed segments:
   the newer manifest is adopted (so the next commit here builds on it) and
   the user is offered to load the segments it lists. A check that crossed
   a commit made here is discarded: whatever it fetched is older.
6. Lock clears memory. The encrypted cache stays on disk and is useless
   without the passphrase.

Any browser with the URL and passphrase gets the same experience. First unlock
on a new device pays one download of the index and shards, later unlocks are
instant.

### Account flows

- **Setup.** Generate DEK, recovery key and salt. Derive the root in the
  worker, expand both KEKs and both auth keys, wrap the DEK twice, build the
  manifest. Register with the server in one request carrying both auth keys,
  the KDF parameters and the manifest, so an account can never exist without
  the wrapped DEK that makes it usable. Log in, persist the session key, show
  the 24 words.
- **Unlock.** Fetch the KDF parameters, derive, log in. A wrong passphrase
  stops here, so the manifest is never fetched with a bad key. Fetch the
  manifest, unwrap the DEK, derive subkeys, persist the session key.
- **Resume** (page load). If sessionStorage holds a wrapped DEK, fetch the
  session key; a 401 means the session is gone, so clear the blob and show
  Unlock. Otherwise unwrap and continue without the passphrase.
- **Lock.** Log out, which deletes the server half of the session key. Clear
  sessionStorage, zero every key.
- **Recover.** Parse the words, derive the recovery KEK and auth key, log in
  with it, unwrap the DEK under the recovery KEK, then rekey with a new
  passphrase and a fresh recovery key. The DEK and the recovery auth key
  wait in memory while the passphrase is chosen; giving up zeroes both and
  logs out (as a beacon when the tab closes).
- **Rekey** (passphrase change, recovery key change, parameter change). New
  salt or new recovery key, rewrap the DEK, rebuild the manifest header, and
  send the changed credentials and the new manifest in one call under the
  manifest's ETag, together with a current credential (the old passphrase's
  auth key, or the recovery auth key) so a hijacked session alone cannot
  rotate anything. One call matters: two separate requests could leave a
  state where one passphrase logs in and the other decrypts. With one, a
  refused call leaves the old passphrase fully working, and the server
  journals the new credentials before it touches the manifest, so a crash
  at any point resolves to one consistent state at the next start (see
  the API). A successful rekey revokes every other session. A response
  lost on the way back is the one gap: the change took, the screen says
  it failed, and in a recovery the new phrase was never shown, so the
  passphrase just chosen is the way in and Settings makes a new phrase.

## Server API

Deliberately small. Every route except health, kdf, setup and login requires
a session. Errors are JSON `{"error":"<code>"}` with a stable code and no
detail.

```
GET    /api/health                    liveness and whether the archive is set up
GET    /api/kdf                       KDF parameters as stored; 409 before setup
POST   /api/setup                     JSON: both auth keys, kdf and the manifest (base64)
                                      → creates the single account, atomically
POST   /api/login                     either auth key → session cookie
POST   /api/logout
POST   /api/rekey                     JSON: current auth key, new credentials and/or
                                      kdf, manifest (base64) and if_match; atomic
PUT    /api/session/key               32 bytes kept in memory on the session
GET    /api/session/key
GET    /api/manifest                  returns ciphertext + ETag
PUT    /api/manifest                  If-Match required once a manifest exists (428/412);
                                      kdf and wrapped must be unchanged (403 header_locked)
HEAD   /api/blobs/<id>                existence check
GET    /api/blobs/<id>
PUT    /api/blobs/<id>                write-once; 409 if the id exists
POST   /api/blobs/exists              batch existence check, list of ids
GET    /api/blobs                     listing, for garbage collection
```

- **Setup.** While the server has no credentials, health reports it and the
  web app shows the create-account screen. The first `POST /api/setup` wins,
  becomes the only account, and the route is refused forever after. There is
  no setup token: an empty archive belongs to whoever reaches it first, which
  on a private network is the operator, and the binary listens on loopback
  unless told otherwise. The server writes the manifest first and the
  credentials second; a manifest orphaned by a crash in between is
  overwritten by the next setup, which is only reachable while there are no
  credentials. Setup, login and rekey run one at a time under a single
  lock, and setup checks for credentials again inside it: a request that
  entered while the archive was empty and dawdled over its body cannot
  replace the manifest of a setup that completed meanwhile, and a login
  cannot open a session on a credential that a rekey has just retired.
- **ETags** are opaque strings the client passes back verbatim, quotes
  included, in `If-Match` on manifest writes and in the `if_match` field of
  rekey. Setup needs none: it creates the manifest. A rejected current
  credential on rekey answers 401 `wrong_credential`, distinct from the 401
  `unauthorized` of a dead session, so the app can say which happened.
- **Credentials.** A version-2 JSON file holding the SHA-256 of the
  passphrase auth key, the SHA-256 of the recovery auth key, and the KDF
  parameters as an opaque JSON object, compacted and capped at 1 KiB, served
  verbatim. Login checks both hashes without short-circuiting. Rekey verifies
  the presented current credential, stages the new credentials in a journal
  (`auth.json.next`) bound to the ETag the new manifest will have, writes
  the manifest under `If-Match`, then installs the journal as `auth.json`.
  At startup a leftover journal is compared with the manifest on disk:
  matching ETag means the manifest went in, so the credentials are
  installed; anything else means it did not, so the journal is dropped.
  Either way credentials and manifest agree. Rekey shares the login rate
  limit.
- **Session key.** Set by the client after unlock, stored only in memory on
  the session record, never on disk, and gone with logout or expiry. Setting
  it again replaces it.
- **Blob ids** are 64 lowercase hex characters and are validated before any
  path is built. Everything else is rejected, which is the path-traversal
  boundary of the server.
- **Write-once is unconditional.** A repeated id is a 409 whatever the body,
  because random nonces mean two encryptions of the same message never match
  byte for byte. The client treats 409 as "already there".
- **Sessions** are random tokens in an HttpOnly, SameSite=Strict cookie,
  stored server-side only as hashes, in memory, with a 24 h idle timeout and
  a 7 day absolute lifetime. A restart logs everyone out; a rekey logs every
  other session out.
- **Abuse limits.** Login, setup and rekey share a per-address rate limit,
  applied before the body is read; the limiter sweeps expired windows at
  most once per window and forgets everything past 65536 addresses. Behind
  a reverse proxy every client shares the proxy's address unless the proxy
  is listed in `--trusted-proxies`, in which case the last address it
  appended to `X-Forwarded-For` is the client. Blob and manifest bodies are
  capped, and a body has two minutes to arrive, fifteen for a blob upload,
  so a request left open cannot hold a connection for as long as it likes.
  State-changing requests must carry a same-origin `Sec-Fetch-Site` or a
  matching `Origin`. There is no storage quota: a session can fill the
  disk, as the owner can.

Storage is a directory on the NAS filesystem, one file per blob under
`blobs/<id[:2]>/<id>`, written to a temp file, fsynced and hard-linked into
place so a crash cannot leave a partial blob; a shard directory is synced
into `blobs/` before its first blob lands. The serving process holds an
advisory lock on `lock` in the data directory, where the filesystem
supports one, so a second process over the same directory refuses to
start. A backup is a plain copy, taken while the server is idle: a copy
made during an import can hold a manifest naming blobs it did not copy,
and one made during a rekey a manifest and credentials of different
generations.

## Out of scope for v1

- IMAP or any live sync with a provider
- Multiple users or archives
- User-defined labels and notes
- Attachment content extraction (PDF text, etc.)
- Garbage collection of orphaned blobs
