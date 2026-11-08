# Live presence: cursors, participants and selections

Everyone on a board can see who else is there, where their pointer is, and what they have
selected. Presence is ephemeral: it travels over the board's sync socket, lives in memory on the
server, and is never written to PostgreSQL or to the document.

## What a participant publishes

Each participant publishes one state, validated by `presenceStateSchema` in
`packages/shared/src/presence.ts`. The server validates every state against the same schema before
it relays it.

```json
{
  "user": { "id": "<uuid>", "name": "Ada", "color": "#1971c2" },
  "cursor": { "x": 412.5, "y": -88 },
  "selection": ["<object uuid>"]
}
```

- **Cursor** is in world coordinates, so it lands on the same spot of the board for everyone, at any
  zoom or pan. A cursor is `null` when the pointer has left the canvas.
- **Selection** is object ids. Other clients outline those objects in the participant's colour.
- **Colour** comes from `colorForUser(userId)`, a stable hash of the user id into a fixed palette.
  The same user gets the same colour everywhere.
- The viewport is not published. Each client places cursors with its own viewport.

## Protocol

Presence uses the awareness frame of the sync protocol (`MESSAGE_AWARENESS`). Its body is a list of
entries, each with a numeric client id, a clock, and the state as JSON text. This is the Yjs
awareness model:

- A newer clock replaces an older state, so frames that arrive out of order cannot move a cursor
  backwards.
- A state of `null` removes the participant.
- Each connection has its own client id. A reconnect gets a new one, so the new states are never
  mistaken for the old clock.

The client implementation is `Awareness` in `packages/shared/src/awareness.ts`. The server uses the
same codec.

### Joining

When a connection joins, the room sends the state vector for the document and then, if anyone is
present, one awareness frame with everyone currently present. A late joiner therefore sees the
whole room at once.

## Server rules

The room keeps presence in `PresenceRegistry` (`apps/api/src/sync/presence.ts`):

- **Ownership.** An id belongs to the connection that first announced it. Another connection that
  sends the same id is closed with 1008. No honest client does that.
- **Validation.** A non-null state must be JSON that matches the presence schema. Otherwise the
  sender is closed with 1008 and nothing is relayed.
- **Ordering.** A state is kept only if its clock is newer than the one held.
- **Removal on leave.** When a connection leaves, every id it held is removed for the others. This
  happens on a clean close and on an unexpected one, where the socket fails during a relay and the
  room drops the connection.
- **Expiry.** A participant that has not refreshed for 30 seconds is removed. The heartbeat, which
  runs every 15 seconds, checks for expiry.
- **Limits.** 200 participants per room. 100 presence frames per second per connection, beyond
  which the sender is closed with 1008. Presence is validated and relayed, but never stored.

Presence is discarded with the room. When the last connection leaves a board, nothing about its
presence remains in memory.

## Client behaviour

- **Publishing.** `PresenceController` (`apps/web/src/canvas/presence/presence-controller.ts`)
  publishes the user, the colour, the cursor and the selection. Cursor moves are throttled to one
  update every 50 ms, with a trailing update, so the last position is always sent. Selection
  changes go out at once. A cursor is published on any pointer movement over the canvas, including
  movement with no button held, so a participant who is only hovering is visible to others.
- **Heartbeat.** Every 15 seconds the client re-sends its state with a newer clock, so an idle
  participant is not dropped. `maintainAwareness` does this and runs the local expiry check every
  5 seconds.
- **Connecting.** The sync provider sends the local state as soon as the socket opens, and forwards
  later changes as they happen. Remote presence it receives is applied without being sent back.
- **Disconnecting.** When the socket closes, the client forgets every remote participant at once,
  because nothing can refresh them while it is offline. They come back from the server's snapshot
  when it reconnects.
- **Stopping.** The controller withdraws its participant with a `null` state.

## Showing presence

- **Toolbar.** The participant list shows everyone present, with their colour and name. This client
  is marked "(you)". The count follows.
- **Connection status.** The toolbar shows Connected, Connecting, Reconnecting, Offline (retrying),
  Disconnected, or Local only for a board-less editor.
- **Cursors.** Each remote cursor is a coloured dot with the participant's name. It is drawn where
  its world position falls in this view. A cursor outside the view is pinned to the nearest edge,
  inset by 16 px, and marked `data-offscreen`. So a viewer looking at one region can tell which way
  to pan to find someone elsewhere.
- **Selections.** Each remote selection is an outline in the participant's colour, mapped through
  this view's zoom and pan. Selections for objects this client does not have yet are skipped.

The overlay is positioned in screen space above the canvas and ignores the pointer, so it never
blocks editing.

## Tests

- `packages/shared/src/awareness.test.ts`: the codec (round trips, size and trailing-byte rules,
  UTF-8), local publishing and heartbeats, the clock rules, removal, expiry and its timeout, losing
  the connection, several participants converging in any order, a late joiner, and rotation of the
  client id on reconnect.
- `apps/api/src/sync/presence.test.ts`: several simultaneous participants in one room. The cases are
  relay without echo, a late joiner's snapshot, a clean leave, an unexpected disconnect mid-session
  (the socket breaks and the room removes the participant and tells the others), a spoofed id, a
  malformed or off-schema state, reordered frames, expiry followed by recovery on a later heartbeat,
  a participant that keeps refreshing, presence never reaching storage or the document, the per-second
  frame limit, and a longer run with four participants moving and two leaving.
- `apps/web/src/canvas/presence/presence.test.ts`: throttle timing, the controller's publishing and
  withdrawal, cursor placement inside and outside a view, world boxes through zoom and pan,
  participant lists that skip damaged states, and the heartbeat and expiry timers.
- `apps/web/src/canvas/presence/PresenceOverlay.test.tsx`: cursors at their view position and pinned
  when off screen, selections through the local transform, and nothing drawn for the local
  participant or for unknown objects.
- `apps/web/src/canvas/sync/provider.test.ts`: presence sent on connect and as it changes, remote
  presence applied without echo, remote participants cleared on disconnect and sent again on
  reconnect.
- `apps/web/e2e/presence.spec.ts` (Playwright, needs the API and PostgreSQL): two browsers on one
  account see each other in the toolbar, one browser's cursor appears in the other, and closing a
  browser removes its participant and cursor.

Nothing here has been run in this environment. The dependencies could not be installed, and no
browser or PostgreSQL server was available.

## Limitations

- **Unverified.** Every test in this stage, including the browser test and the throttle timing, is
  unverified.
- **Single process.** Presence lives in one process's memory, so a second API instance would not see
  the participants on the first. This matches the rooms themselves; see `docs/sync.md`.
- **Colour by user.** Two tabs of one account share a colour, so they are told apart only by their
  names. A per-tab colour would need the colour in the state to be chosen per connection.
- **Expiry is coarse.** A participant whose heartbeat stops is removed within about 30 to 45 seconds,
  and it reappears on its next heartbeat after that one.
- **No viewport outline.** Other participants' viewports are not drawn. Off-screen cursors are the
  way to find people elsewhere on the board.
- **Selections are not locked.** Presence shows what others have selected, but it does not stop two
  people editing the same object.
- **Presence is not in history.** It is correctly excluded from undo and from storage, but there is
  no record of who was present at a given time.
