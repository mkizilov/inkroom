# Offline editing

A board that has been opened while online keeps a copy in the browser. The copy opens without a
connection, edits made offline are kept across reloads, and they reach the server and merge with
other people's changes when the connection returns. The live sync protocol is in
[sync.md](sync.md); this page covers what happens on the device.

## What works offline

- **Opening a board** that was opened online on this device before, including after a reload, when
  the app's own files are also cached (see "The app shell" below).
- **Drawing, moving, deleting and every other canvas edit.** Edits apply at once and are saved on
  the device.
- **Reconnecting.** The sync handshake sends what the server lacks. Concurrent edits merge through
  Yjs, and objects are keyed by id, so an object created offline cannot appear twice.

These need the server, so they fail while offline, with the usual network message: the board list,
creating, renaming or deleting boards, sharing, and the member list. The board page does not show
the sharing panel for an offline copy.

## How it works

**The local copy.** Each board's Yjs updates are saved in IndexedDB (database `inkroom-offline`,
store `updates`). Every update the board document applies is saved, whether the editor made it or
the server sent it, so the saved log is the whole document. Loading the log gives the board as it
was, and the loaded updates are not saved again. After 200 saves the log is replaced by one update
holding the same state, in a single transaction (`apps/web/src/offline/local-board.ts`).

**Cached board details.** The board's title, role and identifiers are kept in store `boards` each
time the board loads online. When the server cannot be reached, the board page opens from these
details.

**Keys.** Everything is keyed by the signed-in user and the board. Two people who use the same
browser never see each other's copies.

**Opening order.** The copy loads first, and the connection starts after it. So the first frame the
server sees already describes the offline state, and the handshake sends the offline changes.

**Sync states.** The toolbar shows one of these labels, which come from
`apps/web/src/canvas/sync/provider.ts`:

- **Online.** Connected. The server has answered the handshake and has stored every change sent.
- **Syncing…** Connected, but the handshake or a stored-change acknowledgement is still pending.
- **Offline, retrying.** The connection is down. Edits are saved on the device and sent when it
  returns.
- **Reconnecting… or Connecting…** A connection attempt is in progress.
- **Disconnected.** The server ended the connection for good. A notice gives the reason when it
  matters to the user.
- **Local only.** The editor has no board behind it (used by tests).

A change counts as pending from the moment it is sent until the server acknowledges it. A change
made offline counts from the reconnect until it is stored.

**Signing in offline.** The app remembers the user who last signed in on this device, in
`localStorage` (`inkroom.lastUser`). When the server cannot be reached, that user stays signed in,
so the saved boards open. The check runs again when the browser comes back online. The session
itself stays in its HTTP-only cookie, which the app cannot read.

**The app shell.** `apps/web/public/sw.js` is a service worker. It answers each request from the
network first, keeps a copy of same-origin responses, and falls back to the copy when the network
fails. Navigations share one entry, because every route of the single-page app is the same HTML.
API responses are never cached. The worker is registered in `main.tsx`, in development and in
production. A user's first visit must be online for the worker to take control, and a reload after
that stores the app's files, so later loads work without a connection.

## Access ends

The server says why it closes a connection, and the copy on the device follows that reason.

- **Membership removed, board deleted, or board not found.** The copy is deleted and saving stops.
  The notice says the copy was deleted.
- **Changed to viewer while open.** Saving stops and the copy is deleted, since unsynced edits can
  no longer reach the server. A notice asks the user to reload to see the board as it is now.
- **Write refused because the role changed.** Treated the same as a removal.
- **Session ended (`not signed in`).** The copy is kept, saving continues on the device, and the
  notice asks the user to sign in again.
- **Board opened and the server says not found.** The copy is deleted before the error shows.

A removal made while the device is offline is noticed when it next connects. Until then the copy
can still be opened offline.

## Local data retention

- **Where.** IndexedDB and `localStorage` for this site, in the browser profile. Nothing is
  encrypted, so anyone with access to the browser profile can read the copies.
- **Who.** Copies are keyed by user, so the app shows one account's copies only to that account.
- **Kept until**, whichever comes first: the access ends (above); the user signs out; the site's
  data is cleared in the browser; or the copy is replaced by the compaction described above, which
  keeps the same changes.
- **Signing out** deletes that user's copies, including changes that have not reached the server.
  There is no confirmation. Sign out once the browser is back online.
- **Not stored:** API responses, member lists and email addresses. The board details saved are the
  board's id, title, owner id, the caller's role and timestamps.
- **Not expired.** A copy of a board that is never opened again stays until one of the events
  above. There is no age-based cleanup yet.
- **Storage limits.** Browsers cap storage per site. A failed save shows a notice, and the change
  stays in memory until the page closes.

## Limitations

- Only boards opened online on this device can be opened offline. The copy is as of the last online
  visit, plus the offline edits.
- No board list, no creating, renaming or deleting, no sharing, and no member list offline.
- Undo history is not saved. After a reload, undo starts empty.
- Concurrent edits to the same field of the same object are resolved by Yjs as last writer wins for
  that field. Text is merged character by character. Stacking order that two people changed at once
  is settled by object id, so it is consistent on every device but may not match either person's
  intent. There is no conflict prompt.
- A viewer whose role was downgraded keeps the changes made before the change until the page is
  reloaded. They are not saved, and they are not sent.
- Offline, revocation and membership changes are seen only at reconnect.
- The service worker serves the files cached by the last online load. A new release takes effect on
  the next online load.
- No encryption at rest, and no age-based cleanup of copies.
- **Write window.** An edit is written to the device copy about 12 ms after it is drawn, measured on
  an idle browser. A reload or a closed tab inside that window can lose the last edit, and nothing
  warns the user yet (ROADMAP step 9).
- **Verified.** The offline browser tests in `apps/web/e2e/offline.spec.ts` pass. The reload test waits
  for the device copy to record the edit before it reloads.
- **Dependencies.** The copy is kept by a small in-house store rather than the `y-indexeddb`
  package. The store is small enough to keep. Replacing it later would not change the saved format.

## Tests

- `packages/shared/src/sync-client.test.ts`: the handshake answers a state vector with step 2 only,
  the acknowledgement and handshake callbacks, and which frames change the document.
- `apps/web/src/offline/local-board.test.ts`: saves and reloads, no re-save on load, two devices
  merging without duplicates, discard, a failed save, and compaction.
- `apps/web/src/offline/user-cache.test.ts`: the remembered user, and a corrupted entry.
- `apps/web/src/canvas/sync/provider.test.ts`: syncing until the handshake and the acknowledgement,
  offline changes pending until stored after a reconnect, the viewer reset, and revocation reasons.
- `apps/web/e2e/offline.spec.ts` (Playwright, needs the API and PostgreSQL): an edit made offline
  survives a reload and reaches a second browser; two people's offline edits merge with no
  duplicates; a deleted board ends access and removes its copy. The connection is controlled with
  Playwright's WebSocket routing, and the network with the browser's offline mode.
