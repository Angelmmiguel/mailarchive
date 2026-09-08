# Views

The screens of the web app and how they connect. Routes are indicative; the
app is a client-side SPA, so every route resolves to the same shell.

## Map

```
first visit ──► Create account ──► Recovery key ──► Own addresses ──┐
                                                                     ▼
returning ────► Unlock ──────────────────────────────────────────► Archive
                  │ "lost passphrase"                                 │
                  ▼                                                   │
                Recover ──► Recovery key ─────────────────────────────┘

Archive (list) ◄──► Thread
   │  search / filters stay in the list
   ├──► Import (panel, keeps the list behind it)
   ├──► Settings
   └──► Lock ──► Unlock (returns to the previous location)

Session expired anywhere ──► Unlock (returns to the previous location)
```

Health (`GET /api/health`) decides the entry point: not set up goes to Create
account, set up goes to Unlock, unless the app already holds keys in memory,
in which case it goes straight to Archive.

## Onboarding (first run only)

### Create account `/setup`
Passphrase and confirmation, with strength feedback. No username: the archive
has exactly one account. Submitting derives the keys, registers the auth key
with the server, creates the manifest and moves to Recovery key.
Errors: passphrases differ, too weak, server already set up (go to Unlock),
server unreachable.

### Recovery key `/setup/recovery`
Shows the recovery key once, with copy and download. Continue is disabled
until the user confirms it is stored. Explains that losing both the
passphrase and this key loses the archive. Moves to Own addresses.

### Own addresses `/setup/addresses`
List of the user's email addresses, add and remove. Used to derive the `sent`
label and to show "to X" instead of "from me" in lists. Can be skipped and
completed later in Settings. Moves to Archive, which is empty and shows the
import prompt.

## Access

### Unlock `/unlock`
Passphrase field, unlock button, link to Recover. On success shows a short
decrypting state with progress while the index loads, then Archive, or the
location the user was at when the session expired.
Errors: wrong passphrase, rate limited (with the wait), server unreachable.

### Recover `/recover`
Three steps on one screen. Step 1: enter the recovery key, which is checked
with the server. Step 2: set a new passphrase and confirmation. Step 3: the
freshly generated recovery key, shown once, then Archive.

## Reading

### Archive `/`
The main screen. A list of threads sorted by date, newest first, each row
showing participants, subject, snippet, date, an attachment indicator and
labels. Search field at the top, with a `?` beside it that opens the syntax
and examples; filter chips for `sent`, `attachments` and a date menu with
presets (any time, last 30 days, last 12 months, each year present) and the
order (best match, newest, oldest). The chips write into the same query
the box holds (`is:sent`, `has:attachment`, `after:`/`before:`), so the two
never disagree; the URL carries the query as `q` and the order as `order`
so a location can be shared between devices. Words match as prefixes as
they are typed; `from:`, `to:`, `subject:`, quoted phrases and `-word`
narrow further, and every part must hold somewhere in the thread.
States: loading index, empty archive (prompt to Import), "indexing" beside
the count while the term shards are still arriving (subjects and names
already answer, bodies as shards come in), no results for the current
search (says what was asked and offers to clear the date range or all of
it), and a banner when another device has added segments since unlock
(offer to reload).
Selecting a row opens Thread. On wide screens Thread opens beside the list;
on narrow screens it replaces it.

### Thread `/t/<thread key>`
The messages of one conversation, oldest first, all collapsed except the
latest. The key is an HMAC of the thread id under the id key, so the address
a hard reload sends the server names nothing, and every device derives the
same one. An expanded message shows a bar that chooses the view (text,
sanitized HTML or source), toggles images and downloads the original
`.eml`, then from, to, cc, date, the body and its attachments as chips.
Per thread: previous and next thread in the current list, back to Archive.
Attachment chips open the file in a new tab for images and PDFs, otherwise
download it.

## Import

### Import (panel over Archive)
Drop zone or pickers for `.eml` files and folders; the whole page is a drop
target too. Once files are chosen, the panel turns into a progress view with
counts for parsed, uploaded, skipped as duplicates and failed, an estimate,
and a cancel button. The user can close the panel and keep browsing; the
Import button in the shell shows the percent and reopens it. Ends with a
summary toast and a link to the archive. Cancelling keeps what finished.
Errors: a file that does not parse (listed, import continues), a server
failure (the run stops, what finished is kept, the panel says why).

## Settings

### Settings `/settings`
Sections: own addresses (same editor as onboarding, saved when changed),
change passphrase (asks for the current one), regenerate recovery key
(asks for the current passphrase, shows Recovery key again), archive
statistics (messages, threads, storage, segments), clear this device's
cache, and Lock.

## Shell

Present around every view after unlock: search entry, Import button with the
background progress indicator, Settings, Lock. Toasts for errors and
completed imports. A persistent banner when the server is unreachable.

## Implementation notes

Things the account layer cannot handle on its own and the screens must.

- **Setup that succeeds without showing the phrase.** `createAccount` sends
  the account and manifest in one request; if the login or manifest fetch
  right after it fails, the account exists and the passphrase unlocks it, but
  the recovery phrase was never displayed. `createAccount` reports this as
  `SetupUnfinishedError`; Create account tells the user the account was
  created, links to Unlock and says to generate a recovery key from Settings.
  Covered by `web/tests/e2e/setup-unfinished.spec.ts`.
- **The recovery phrase lives in memory between two screens.** Create account
  leaves it in `state/onboarding.svelte.ts`; Recovery key shows it and
  forgets it on Continue. After a reload the phrase is gone while the session
  resumes, so Recovery key then says the key cannot be shown again and points
  to Settings instead of pretending.
- **The Argon2id worker is only bundled once a route imports it.** Create
  account reaches `deriveRootInWorker` through the account layer, so the
  build emits `_app/immutable/workers/kdf.worker-*.js`; the onboarding spec
  asserts a worker with that name starts when Continue is pressed.
- **Unlock knows why it was reached and where to return.** The reason
  (`already-set-up`, `expired`) and the location (`next`) travel in the
  query string so that both survive a reload. `returnPath` in
  `lib/app/navigation.ts` accepts only a path inside the app, so a crafted
  link cannot send a freshly unlocked user to another origin. Lock builds the
  URL with `unlockUrl` from the current location.
- **The list and the reader share one listing.** `state/view.svelte.ts`
  derives the visible threads from the index, the term index and the
  query. The shell's search box edits that query directly, so the chips
  see every keystroke, and pushes it to the URL (`q`, `order`) a moment
  after typing stops; a URL that changes from elsewhere (back, a link)
  resets the query. Every thread link keeps the query string, so a
  location carries its search. The reader finds its position, previous
  and next in that same listing, which under "best match" can shift as
  shards arrive; a thread the query hides reads `– / n`. Thread rows are links to
  `/t/<key>` and the arrow keys (or j and k) move the selection from
  anywhere that is not a text field.
- **Bodies are rendered from the view blob, sanitized every time.** HTML
  goes through DOMPurify (`lib/mail/sanitize.ts`) into a shadow root, so
  the message's styles stay in and the page's stay out; scripts, forms,
  embedded documents and image sources are removed, links open in a new
  tab without a referrer. "Images" in a message's bar shows them for
  the thread being read only: remote ones from their source, `cid:` parts
  from the raw blob as object URLs; the next thread starts with them off.
  HTML is the view a message opens in when it has HTML, text otherwise. The original `.eml`, its source and its attachments
  come from the raw blob, decrypted and, for attachments, parsed again in
  the browser; images, PDFs and plain text open in a tab, the rest download.
- **Segments from another device.** The Archive layout checks the manifest
  every minute and when the tab regains focus (`lib/account/sync.ts`); a
  newer manifest is adopted at once, and the strip above the list offers to
  load the segments it brought. Nothing reorders under the reader on its own.
- **Health goes stale after Create account.** The shell reads
  `GET /api/health` once per page load, before the account exists, so Create
  account marks the archive as set up itself once the flow moves on. Screens
  that redirect check for an open session before they look at health.
- **Not yet built.** The decrypting-index progress after a correct
  passphrase (there is no index to decrypt), the attempts-left count in the
  wrong-passphrase message (the server does not report it; the rate-limited
  message asks to wait a minute, the default window).
- **Recover holds keys between its steps.** The key opens the archive
  before the passphrase is asked, so the DEK and the login wait in the
  screen; leaving it, or Start over, zeroes them and logs out, and a tab
  that closes meanwhile sends the logout as a beacon.
- **Lock is one function.** `lib/app/lock.ts` drops the keys and goes to
  Unlock with the way back; the toolbar, Settings and an expired import
  use it.
- **Import lives in the shell.** The panel, the page-wide drop target and the
  toasts are mounted by the layout once the session is unlocked, so a run
  keeps going while the user moves between views. `lib/import/start.ts`
  owns the run: it refuses a second selection while one is running, warns
  through `beforeunload` until the run ends, and turns the outcome into the
  summary toast. Lock waits for a running import to cancel and commit what
  it finished before the keys go; a session that expires mid-run leaves the
  uploaded blobs on the server, reports it, and goes to Unlock.
- **The index is decrypted at Unlock and at boot.** Both call `openIndex`
  after the session opens; Unlock shows the decrypting panel meanwhile. A
  segment the server lost is reported as a toast and the archive opens with
  the rest, so one missing blob never locks the user out.
- **Fixtures are synthetic.** `web/tests/fixtures` holds `.eml` files modelled
  on real provider exports (a base64 HTML newsletter with an encoded subject,
  a report with an inline logo and a PDF in a `multipart/related` container,
  a plain-text reply, a re-export with other transport headers, and two files
  that are not mail) without anyone's real addresses.
