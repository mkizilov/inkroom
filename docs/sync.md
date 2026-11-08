# Real-time synchronization

Every board has a live sync room. Browsers open a WebSocket to the board's endpoint and exchange
Yjs updates, so an edit in one browser appears in every other browser open on the same board,
without a reload. Updates are stored in PostgreSQL before they are applied or acknowledged. See
[persistence.md](persistence.md) for the storage model, recovery and revision history.

## Endpoint

`GET /api/boards/:boardId/sync` (WebSocket upgrade). The browser sends its session cookie with the
upgrade, and the connection must come from the web origin (`WEB_ORIGIN`), the same rule the HTTP
write routes apply.

## Wire protocol

The frames are the y-protocols version 1 format, implemented in
`packages/shared/src/sync-protocol.ts`, so the server and the browser use one definition:

| Frame                      | Meaning                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| sync step 1 (state vector) | "Here is what I have." The receiver replies with what the sender lacks, and sends its own state vector. |
| sync step 2 (update)       | Updates the receiver lacks, sent as the reply to step 1.                                                |
| sync update                | One change made by a client, relayed to the other clients.                                              |
| awareness                  | Presence (cursors and names). Ephemeral, per connection.                                                |

A frame is a varint outer type, then its payload as length-prefixed bytes. Decoding rejects a
truncated frame, an unknown type, a payload over the limit, and trailing bytes.

**Join handshake.** When a connection joins, the room sends its state vector. The client replies
with step 2 (what the room lacks). The client sends its own state vector, and the room replies with
step 2 (what the client lacks). A state vector is answered with step 2 only. Answering it with
another state vector would never end: both sides would keep answering each other. Both sides then
hold the same state. A client that was offline sends its offline changes through the same handshake.
The browser also keeps them on the device until the server stores them; see [offline.md](offline.md).

## Connection flow

1. The route reads the session cookie and resolves the user. Missing, expired or revoked sessions
   get close code 1008 and no board data.
2. `SyncService.open` looks up the user's role on the board. A non-member gets 1008 with the same
   reason as a missing board, so board ids cannot be probed.
3. The user's connection budget is checked (`maxConnectionsPerUser`, default 20).
4. The connection joins the board's room (`maxConnectionsPerRoom`, default 50) and receives the
   room's state vector.
5. Viewers join read-only (see below).

## Roles

- **Owner and editor** connections apply their updates to the room and receive everyone else's.
- **Viewer** connections receive the document. Their step 2 and update frames are dropped without
  effect, and the connection stays open, so a viewer's client does not reconnect in a loop. A
  viewer's reconnect reply can carry only a delete set (Yjs always includes one), so refusing such
  frames would disconnect every viewer of a board that has had a deletion.
- **The database checks again.** Each stored update and each restore re-reads the writer's role
  inside the transaction that holds the board lock. A write from someone who is no longer an owner
  or editor fails, and the room closes that connection with 1008.

The canvas refuses edits from a viewer, so this drop is a backstop for a client that ignores the
UI. See the viewer-echo limit below.

## Changes to access during a session

- A **role change** is applied to the open connection at once. The server sends a role frame
  (`MESSAGE_ROLE`, 3), so the browser becomes read-only without reconnecting.
- **Removing a member** closes their connections with 1008 and the reason `access revoked`.
  **Deleting the board** closes every connection with the reason `board was deleted`. The browser
  stops rather than retrying on 1008.
- A change made by **another process** is not pushed. Each open connection's role and session are
  re-read every 30 seconds (`membershipCheckMs` in `buildApp`, started with the heartbeat), so such a
  change takes effect within that interval. Writes are checked against the database in the meantime.
  A session that was signed out elsewhere, revoked or expired closes its sockets at the next check.
- **Signing out** closes the sockets of that session at once, in the process that handled the
  sign-out. A sign-out handled by another process takes effect at the next check.

## Limits

| Limit                       | Default               | Enforced by                                                                    |
| --------------------------- | --------------------- | ------------------------------------------------------------------------------ |
| Frame size                  | 1 MiB                 | Connection: close 1009 before the frame is decoded                             |
| Payload size inside a frame | 1 MiB                 | Protocol decoder                                                               |
| Update bytes per second     | 4 MiB, per connection | Room. Over the budget the frame is refused and the connection is closed (1008) |
| Connections per room        | 50                    | Room join                                                                      |
| Connections per user        | 20                    | Service, across all boards                                                     |
| Buffered outgoing bytes     | 8 MiB                 | Connection: a slow reader is closed (1013)                                     |

All limits are configurable through `roomLimits` and `connectionLimits` in `buildApp`.

## Heartbeats and cleanup

- The server pings each connection every 15 seconds. A connection that has not answered within 30
  seconds is closed with 1001, and its presence is removed.
- Closing a connection removes it from its room. If the room is empty, its document is destroyed,
  so an idle board holds no memory.
- When a connection leaves, the room tells the others that its awareness entries are gone. The
  removal carries a clock above the last one the client sent, because peers ignore an update whose
  clock is not newer than the one they hold.
- Shutdown closes every connection with 1000 and stops the heartbeat. The server calls it from its
  signal handler.

## Reconnection (browser)

`SyncProvider` (`apps/web/src/canvas/sync/provider.ts`) reconnects after an unexpected close, with
exponential backoff from 500 ms to 15 s and full jitter, so many clients do not reconnect together.
The backoff resets once a connection has opened. A close with code 1008 means the server refused
the board, for example because it was deleted, and the provider stops rather than retrying.
Changes made while offline stay in the document, are saved on the device, and are sent on reconnect, because the first frame
on a new connection is the client's state vector.

## Tests

- `packages/shared/src/sync-protocol.test.ts`: varints at their boundaries, payload limits,
  truncated and oversized frames, unknown types, and trailing bytes.
- `apps/api/src/sync/room.test.ts`: two and more simulated clients, each with its own `Y.Doc`,
  connected to one room. They cover initial state for a late joiner, drawing, moving and deleting
  seen by the other client, concurrent text merges, 40 interleaved edits from two clients, a client
  that reconnects after missing edits, viewers, the per-connection rate limit, the room's size
  limit, a broken socket, and presence removal with the clock rule.
- `apps/api/src/sync/sync.integration.test.ts` (needs `TEST_DATABASE_URL`): owner and viewer
  admission, the same answer for non-members and missing boards, the per-user budget and its
  release, two clients converging through the service, an oversized frame closing only its sender,
  removal from the room when a socket is gone, role changes and removals applied to open connections
  (including the membership check), board deletion, and the database refusing writes from non-editors.
- `apps/web/src/canvas/sync/provider.test.ts`: the handshake, local changes sent as they are made,
  backoff growth and its cap, the reset after a successful open, offline status, stopping on 1008,
  stopping on `stop()`, and offline changes carried by the reconnect handshake.
- `apps/web/e2e/realtime-sync.spec.ts` (Playwright, needs the API and PostgreSQL): two browser
  contexts signed in to one account. Drawing, moving and deleting in one updates the other with no
  reload.

- `packages/shared/src/sync-client.test.ts`: the handshake answers a state vector with step 2 only,
  the acknowledgement and handshake callbacks, and which frames change the document.
- `apps/web/src/offline/local-board.test.ts` and `apps/web/e2e/offline.spec.ts`: the device copy, and
  offline edits, reloads and revocation in the browser. See [offline.md](offline.md).

## Known limits

- **Not verified in this environment.** The WebSocket route depends on `@fastify/websocket` and `ws`,
  which could not be installed. The room and provider tests run without a network, but nothing in
  this stage has been run.
- **Authentication is checked after the upgrade.** `@fastify/websocket` runs the handler after the
  socket is open, so an unauthenticated client gets an open socket that is closed with 1008 before
  any board data is sent. Rejecting the upgrade itself would need a `verifyClient` hook.
- **Changes made by another process take up to the check interval.** Changes made in this process
  apply at once. A change made elsewhere, including a session that ends, reaches an open connection
  within the 30-second access check. Until then, writes are checked against the membership in the
  database but not against the session, so a session that ended elsewhere can still write for up to
  that interval.
- **Viewer echo.** The canvas refuses a viewer's edits, so a viewer's copy changes only through a
  client that ignores the UI. The server drops such a write, so other users never see it, but that
  copy can differ from the board until it reloads.
- **Single process.** Rooms and connection counts live in one process's memory. Several API
  instances would each hold a separate room for the same board, so horizontal scaling needs a
  shared broadcast layer (for example Redis or Postgres notifications).
- **Acknowledgements only drive the sync state.** The server sends `MESSAGE_ACK` after each update
  is stored. The browser counts the changes it has sent that are not acknowledged yet, to show
  "Syncing…" (see [offline.md](offline.md)), and nothing else depends on the acknowledgement. Reconnection does not rely on acknowledgements: the
  state-vector handshake covers unacknowledged changes.
- **Awareness is relayed as received.** The server reads client ids and clocks to track presence,
  but does not validate the state JSON. Malformed presence reaches peers unchanged.
- **The rate limit is per connection, not per user.** A user can open up to the per-user cap (20)
  connections, each with its own 4 MiB/s budget, so one account can exceed what a single connection
  allows. A per-user budget across connections is the next step.

## Presence

Participants' cursors, names, colours and selections travel over the same socket as awareness
frames. They are relayed in memory, a joining connection receives everyone who is present, and they
are removed when a connection leaves or stops refreshing. Presence is never stored. See
[presence.md](presence.md) for the rules, the client behaviour and the limits.
