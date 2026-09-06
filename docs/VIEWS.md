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
Step 1: enter the recovery key. Step 2: set a new passphrase and confirmation.
Then Recovery key is shown again with a freshly generated key, and the flow
ends in Archive.

## Reading

### Archive `/`
The main screen. A list of threads sorted by date, newest first, each row
showing participants, subject, snippet, date, an attachment indicator and
labels. Search field at the top; filter chips for `sent`, `attachments` and a
date range. Search and filters narrow the same list in place; the URL carries
the query so it can be shared between devices.
States: loading index, empty archive (prompt to Import), no results for the
current search, and a banner when another device has added segments since
unlock (offer to reload).
Selecting a row opens Thread. On wide screens Thread opens beside the list;
on narrow screens it replaces it.

### Thread `/t/<thread id>`
The messages of one conversation, oldest first, all collapsed except the
latest. An expanded message shows from, to, cc, date, subject, the body
(text or sanitized HTML, with a toggle) and its attachments as chips.
Per message: download attachment, download the original `.eml`, view source.
Per thread: previous and next thread in the current list, back to Archive.
Attachment chips open the file in a new tab for images and PDFs, otherwise
download it.

## Import

### Import (panel over Archive)
Drop zone or folder picker for `.eml` files. Once files are chosen, the panel
turns into a progress view with counts for parsed, uploaded, skipped as
duplicates and failed, an estimate, and a cancel button. The user can close
the panel and keep browsing; a small progress indicator in the shell reopens
it. Ends with a summary and a link to the newly imported messages.
Errors: a file that does not parse (listed, import continues), session
expired (Unlock, then resume), server unreachable (pause and retry).

## Settings

### Settings `/settings`
Sections: own addresses (same editor as onboarding), change passphrase,
regenerate recovery key (shows Recovery key again), archive statistics
(messages, threads, storage used, segments), clear this device's cache, and
Lock. Later: garbage collection, user-defined labels.

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
- **Health goes stale after Create account.** The shell reads
  `GET /api/health` once per page load, before the account exists, so Create
  account marks the archive as set up itself once the flow moves on. Screens
  that redirect check for an open session before they look at health.
- **Not yet built.** The decrypting-index progress after a correct
  passphrase (there is no index to decrypt), the attempts-left count in the
  wrong-passphrase message (the server does not report it; the rate-limited
  message asks to wait a minute, the default window), the no-results state
  of Archive (it belongs to the list), and Import, whose button the empty
  archive shows disabled. Recover is a placeholder that Unlock links to.
