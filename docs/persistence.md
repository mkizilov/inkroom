# Persistence and revision history

A board's collaborative state is stored in PostgreSQL. A board survives server restarts, every
change a client was told was saved is in the database, and the history of the board can be
browsed and restored by its owner. The code is in `apps/api/src/persistence/` and
`apps/api/src/sync/`, and the schema is in `apps/api/src/db/schema.ts` and `apps/api/drizzle/`.

## Storage model

| Table                  | Holds                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `yjs_document_updates` | One row per stored client update. `seq` is an identity column that orders the log.     |
| `board_snapshots`      | A complete document state. Each row has a `revision` number, a `kind`, and provenance. |

A snapshot with `up_to_seq = U` contains the effect of every update row with `seq <= U` for its
board. So a board's state is its latest snapshot plus the update rows after it. Snapshot metadata:

- `revision`: 1, 2, 3, ... per board, unique within the board.
- `kind`: `compaction` (folded updates) or `restore` (a restored state). A check constraint ties
  `restored_from` to `kind = 'restore'`.
- `created_by`: the owner who restored, or null for compaction. Deleted users keep the revision.
- `restored_from`: the revision a restore copied.

Migration `0002_revisions` adds these columns. It numbers existing snapshot rows, although a
database built before this stage has none.

## Invariants

These are what keep a board consistent. Each one is relied on by code and tested.

1. **Memory never runs ahead of the database.** A client update is applied in memory, broadcast,
   and acknowledged only after its row has committed.
2. **Commit order is sequence order, per board.** Every write takes a row lock on the board
   (`for update`), held until commit. A later write cannot commit with a lower sequence number than
   an earlier one, so a snapshot never misses an update that commits late.
3. **Loads see one state.** A load takes a shared lock (`for share`) and reads the snapshot and its
   updates inside one transaction, so it never combines a snapshot with rows that a compaction has
   since removed.
4. **Compaction and restore are atomic.** The new snapshot and the removal of the rows it covers
   commit together, or not at all.
5. **Snapshots are never edited.** A revision is a fixed point in history.

## Write path

For a client update frame (or a step-2 reply, which is how a reconnecting client sends its offline
edits):

1. The frame is decoded, and the update is checked with `Y.decodeUpdate`. A malformed update closes
   the sender with 1008 and is not stored.
2. An update with no new structs or deletes is not stored, so a no-op reconnect writes nothing.
3. The rate budget for the connection is charged.
4. The update is inserted under the board lock, and the transaction commits. The sequence number is
   returned.
5. The update is applied to the room's document, broadcast to the other connections, and
   acknowledged to the sender with `MESSAGE_ACK(seq)`.

If step 4 fails, nothing is applied, broadcast or acknowledged. The sender's connection is closed
with 1011, and the client still holds the update. It sends it again on its next connection, because
the state-vector handshake covers every change the client has that the server lacks. A board
deleted during a session makes step 4 fail with `BoardNotFoundError`, and the connection closes
with 1008 `board was deleted`.

Writes are handled one at a time per room, in arrival order, so the stored order matches the order
the room applied them.

## Recovery

A room is loaded from the store when its first connection arrives. Concurrent first arrivals share
one load. The load applies the latest snapshot and then the updates after it, in sequence order.

If a stored update cannot be applied, the load skips that row and reports it through the app log
(`skipped an unreadable stored update`). The board still loads, and the next compaction removes the
row. This avoids a single bad row making a board unopenable, but it does mean the change in that
row is lost. Rows are validated before they are stored, so this should only happen if the database
is damaged or the library changes meaning.

A restart therefore needs no special step. The process starts, the first connection to a board
reloads it, and clients reconcile through the handshake.

## Compaction

Compaction folds a board's updates into a new snapshot and removes the folded rows. A revision is
created by each compaction.

It runs in three situations:

- **Activity:** a room asks for compaction after 200 stored updates (`compactEvery`).
- **Release:** a room that stored updates since its last compaction asks for one when its last
  connection leaves.
- **Sweep:** every 5 minutes, boards with more than 500 stored update rows are compacted
  (`sweepThreshold`). This catches boards left behind by a crash.

Steps, all in one transaction under the board lock:

1. Read the latest snapshot and the update rows after it.
2. If there are none, delete any rows a snapshot already covers and stop. No revision is created.
3. Encode the rebuilt state, and insert it as a new snapshot with the next revision number.
4. Delete the rows with `seq <= up_to_seq`.
5. Commit.

If anything fails before step 5 commits, the transaction rolls back and the board is as it was. The
test suite simulates a failure just before the commit and checks this.

A snapshot is limited to 16 MiB by a check constraint. A board that grows past that cannot be
compacted, and compaction fails and is logged. Its update log keeps growing until the document is
reduced. Single updates are limited to 1 MiB.

## Revision history

- **Browse.** Every member can list a board's revisions, and read one with its objects. Revisions
  are the snapshots, so history is available at compaction points, not for every edit. Changes
  between two compactions are not separately addressable.
- **Restore.** Only the owner can restore. A restore makes the board's content equal to the
  revision's content. The change is written as ordinary updates, so connected editors receive it
  at once, and it is recorded as a new revision (`kind: restore`, `restored_from` set to the source).
  Earlier revisions are unchanged, and the history keeps growing. Restoring the content that is
  already current writes nothing and creates no revision.

The restore is computed from the typed object model: it diffs the current objects against the revision's objects and writes the difference. It does not replay old updates.

Edits that a client made but had not yet sent when the restore ran are applied after it. Their
effect on objects the restore just changed follows the normal merge rules.

## HTTP

| Method | Path                                               | Who        | Result                                                                         |
| ------ | -------------------------------------------------- | ---------- | ------------------------------------------------------------------------------ |
| GET    | `/api/boards/:boardId/revisions`                   | any member | `{ items: Revision[] }`                                                        |
| GET    | `/api/boards/:boardId/revisions/:revision`         | any member | `{ revision, objects }`                                                        |
| POST   | `/api/boards/:boardId/revisions/:revision/restore` | owner      | `201 { changed: true, revision }`, or `200 { changed: false, revision: null }` |

Unknown revisions return 404 `revision_not_found`. Non-members get 404 `board_not_found`. Editors and
viewers who try to restore get 403 `forbidden`. The POST is a state-changing request, so it needs
the web origin like the other writes.

## Operations

- Each client update is one database transaction, so an active drag causes a few transactions per
  second per editor. Batching is not implemented. Throughput has not been measured in this
  environment.
- The room's in-memory document is released when the last connection leaves, and reloaded from the
  database on the next connection. Memory use therefore follows active boards only.
- Shutdown closes connections, releases rooms (which may start a final compaction), and waits for
  background work before the process exits.

## Tests

- `apps/api/src/persistence/store.integration.test.ts` (needs `TEST_DATABASE_URL`): reconstruction
  after a restart, compaction removing covered rows without changing the state, updates after a
  compaction, interrupted compaction leaving the board intact, concurrent appends and compactions
  losing nothing, historical revisions, unknown revisions, restore as a new revision with history
  kept, a restart after a restore, restore as a no-op, the restore update bringing a live replica
  to the restored state, a board loading past an unreadable row, writes refused for a deleted
  board, and the sweep's threshold.
- `apps/api/src/sync/room.test.ts` (in memory, no database): updates stored before they are seen,
  acknowledgement with the stored sequence number, nothing applied or broadcast when a write fails,
  a retry of a failed update succeeding, rebuilding after the room is released, no-op updates not
  stored, restore changes applied without re-storing, compaction requested at the threshold, viewers
  unable to write, and the limits.
- `apps/api/src/sync/sync.integration.test.ts` (needs the database): admission and authorization,
  two clients converging, a restart where a new service rebuilds the board, acknowledgements, a
  failed write closing only its sender, oversized frames, and release on close.
- `apps/api/src/boards/revisions.integration.test.ts` (needs the database): the HTTP matrix for
  browsing and restoring, by owner, editor, viewer and non-member, plus the cross-site check and
  the no-op restore.

Nothing in this stage has been run in this environment. The dependencies could not be installed and
no PostgreSQL server was available. See the limitations below.

## Limitations

- **Unverified.** The schema, the migration, the locking behaviour, `Y.decodeUpdate`, and every test
  in this stage are unverified. Each claim above is what the code is written to do, not what has
  been observed.
- **Single process.** Rooms are in one process's memory. A second API instance would hold a
  separate room for the same board. Coordinating instances needs a shared notification channel and
  a rule for who compacts.
- **Revision granularity** is the compaction, so history is not browsable between compactions.
- **Unreadable rows are skipped**, not repaired. The skipped change is lost, and only the log shows
  it.
- **No retention policy.** Revisions are kept until the board is deleted. A board's storage grows
  with its restores and its compactions.
- **Concurrent edits** made during a restore are applied after it, under the normal merge rules.
- **Board deletion** does not close live rooms until their next write; the next write closes that
  connection with 1008.
- **No history UI.** The history is available through the HTTP routes above. The web app has no
  revision browser or restore control.
