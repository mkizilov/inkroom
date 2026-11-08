# Real-time synchronization

Every board has a live sync room. Browsers open a WebSocket to the board's endpoint and exchange
Yjs updates, so an edit in one browser appears in every other browser open on the same board,
without a reload. Persistence is not part of this stage: a room's document lives in memory and is
discarded when the last connection leaves.

## Endpoint

`GET /api/boards/:boardId/sync` (WebSocket upgrade). The browser sends its session cookie with the
upgrade, and the connection must come from the web origin (`WEB_ORIGIN`), the same rule the HTTP
write routes apply.

## Wire protocol

The frames are the y-protocols version 1 format, implemented in
`packages/shared/src/sync-protocol.ts`, so the server and the browser use one definition:

| Frame                     | Meaning                                                     |
| ------------------------- | ----------------------------------------------------------- |
| sync step 1 (state vector) | "Here is what I have." The receiver replies with what the sender lacks, and sends its own state vector. |
| sync step 2 (update)      | Updates the receiver lacks, sent as the reply to step 1.    |
| sync update               | One change made by a client, relayed to the other clients.  |
| awareness                 | Presence (cursors and names). Ephemeral, per connection.    |

A frame is a varint outer type, then its payload as length-prefixed bytes. Decoding rejects a
truncated frame, an unknown type, a payload over the limit, and trailing bytes.

**Join handshake.** When a connection joins, the room sends its state vector. The client replies
with step 2 (what the room lacks), and then the room replies to the client's state vector with what
the client lacks. Both sides then hold the same state. A client that was offline sends its offline
changes through the same handshake, so nothing is queued on the client.

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
  effect, and the connection stays open, so a viewer's client does not reconnect in a loop.

The browser also hides editing from viewers, so this only matters for a client that ignores the
UI. See the viewer-echo limit below.

## Limits

| Limit                       | Default   | Enforced by                                         |
| --------------------------- | --------- | --------------------------------------------------- |
| Frame size                  | 1 MiB     | Connection: close 1009 before the frame is decoded  |
| Payload size inside a frame | 1 MiB     | Protocol decoder                                    |
| Update bytes per second     | 4 MiB, per connection | Room. Over the budget the frame is refused and the connection is closed (1008) |
| Connections per room        | 50        | Room join                                           |
| Connections per user        | 20        | Service, across all boards                          |
| Buffered outgoing bytes     | 8 MiB     | Connection: a slow reader is closed (1013)          |

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
Changes made while offline stay in the document and are sent on reconnect, because the first frame
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
  and removal from the room when a socket is gone.
- `apps/web/src/canvas/sync/provider.test.ts`: the handshake, local changes sent as they are made,
  backoff growth and its cap, the reset after a successful open, offline status, stopping on 1008,
  stopping on `stop()`, and offline changes carried by the reconnect handshake.
- `apps/web/e2e/realtime-sync.spec.ts` (Playwright, needs the API and PostgreSQL): two browser
  contexts signed in to one account. Drawing, moving and deleting in one updates the other with no
  reload.

## Known limits

- **Not verified in this environment.** The WebSocket route depends on `@fastify/websocket` and `ws`,
  which could not be installed. The room and provider tests run without a network, but nothing in
  this stage has been run.
- **Authentication is checked after the upgrade.** `@fastify/websocket` runs the handler after the
  socket is open, so an unauthenticated client gets an open socket that is closed with 1008 before
  any board data is sent. Rejecting the upgrade itself would need a `verifyClient` hook.
- **Role changes and deletion are not pushed to live connections.** A connection keeps the role it
  had when it joined. A removed member, or a board that is deleted, stays connected until it
  reconnects. Closing affected connections on membership changes is the next step, and it needs
  membership management first.
- **Viewer echo.** A viewer's own copy keeps any local edit it makes, because nothing reverts it on
  the client. The server drops the write, so other users never see it, but the viewer's view can
  differ from the board until it reloads. The browser should block editing for viewers outright.
- **Single process.** Rooms and connection counts live in one process's memory. Several API
  instances would each hold a separate room for the same board, so horizontal scaling needs a
  shared broadcast layer (for example Redis or Postgres notifications).
- **No persistence.** A board's state survives only while someone is connected. Persistence and
  snapshot compaction are the next stage.
- **Awareness is relayed as received.** The server reads client ids and clocks to track presence,
  but does not validate the state JSON. Malformed presence reaches peers unchanged.
- **The rate limit is per connection, not per user.** A user can open up to the per-user cap (20)
  connections, each with its own 4 MiB/s budget, so one account can exceed what a single connection
  allows. A per-user budget across connections is the next step.
