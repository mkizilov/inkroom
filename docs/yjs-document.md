# Yjs document model

A board's canvas is stored as a Yjs document. The typed object model in `@inkroom/shared` is still
the contract: every object is a value of that type, and conversion to and from Yjs is done in one
module. Nothing sends or receives updates over the network yet. The document is local, and the
layer is built so that a WebSocket transport can be added later without changing the editor.

## Layers

```
React (CanvasEditor)
  └─ useEditorState ── subscribes ──┐
                                    ▼
EditorSession  (session.ts)   reducer state (view) + outbox
  │  dispatch → editorReducer → state; outbox writes applied in order
  ▼
CanvasDocument (doc/canvas-document.ts)   Y.Doc, Y.UndoManager, origins, notifications
  │  apply(operations) → one Yjs transaction
  ▼
model (doc/model.ts)   typed CanvasObject ⇄ Y.Map entries, Y.Text for text, z-order
```

- **Reducer (`editor.ts`)** is pure. It computes the view and records each document change as a
  batch of operations in `outbox`. It never touches Yjs.
- **Session (`session.ts`)** applies the outbox in order. Each batch is one transaction. Undo and
  redo are forwarded to the document. When the document changes from anywhere else, the session
  adopts the new objects into the view.
- **Document (`canvas-document.ts`)** owns the `Y.Doc`, the `Y.UndoManager`, and the origins. It
  validates a batch before writing, so an invalid batch changes nothing.
- **Model (`doc/model.ts`)** converts. It is the only code that reads or writes the Yjs shape.

## Storage layout

```
doc.getMap('objects')                       Y.Map<id, Y.Map>
  <id>                                      Y.Map
    type, x, y, stroke, strokeWidth, ...    plain values (number, string, array)
    text                                    Y.Text   (text objects only)
    z                                       number   (z-order position, dense 0..n-1)
```

- Each object is a nested `Y.Map` keyed by its UUID. Changing one field is a change to one entry,
  so two edits to different fields of the same object both survive a merge.
- Text is a `Y.Text`. A text update replaces only the characters that changed, so concurrent
  edits at different places in the same text merge.
- Pen points and other array fields are stored as plain values. Concurrent changes to the same
  array field resolve to one of them, last writer wins. Pen strokes are not edited concurrently in
  practice, because a stroke is created and then left alone.
- **Z-order** is the `z` field. After each local write the values are renumbered to `0..n-1`.
  Objects are read in ascending `z`, and ties are broken by id, so every replica reads the same
  order. Concurrent reorders can leave ties or gaps until the next local write renumbers them;
  `consistencyProblems` reports this.

Values read from the document are shared with it. Callers must not mutate them.

## Operations and transactions

Every local change is a list of the operations from `@inkroom/shared`: `insert`, `remove`,
`update` and `reorder`. `writeOperations` applies them to the Yjs map inside one transaction, and
they mean exactly what `applyOperations` means on the typed model. The tests check that the two
agree.

Transactions are used for:

- object creation (insert), deletion (remove), dragging and resizing (update, sent on every pointer
  move), text editing (update, sent on every change of text), and layer changes (reorder).

A drag sends one update per pointer move, inside its own transaction. The move is one undo step
(see below), so undo reverts the whole drag.

## Undo and origins

`Y.UndoManager` tracks only transactions whose origin is `LOCAL_ORIGIN`. Remote updates are applied
with `REMOTE_ORIGIN`, which is not tracked.

- Local undo reverts only this replica's own changes. A change made by someone else stays in place.
- An undo step groups every local transaction that falls within the capture window, which is
  60 seconds, unless a write is marked as a boundary. A boundary starts a new step.
- The editor marks the first write of each discrete action (create, delete, paste, nudge, layer
  change) and of each gesture (drag, resize, text session) as a boundary. Later writes in the same
  gesture or text session join it.
- Undo and redo call `stopCapturing` before and after, so the step just reverted is not merged
  with the next edit.
- A new local write after an undo discards the redo steps, as usual for Yjs.

Undo during a drag cancels the drag instead of undoing history. Cancelling a drag writes the
starting objects back, and that write joins the open step, so the drag leaves no undo step.

Subscribers receive every change with its origin, so the session can ignore its own writes and
react only to remote changes and undo. Undo and redo are reported with a non-local origin, so the
session adopts the document's state after them.

## Convergence

The tests in `doc/canvas-document.test.ts` check that replicas converge:

- A seeded sequence of inserts, removals, moves, text edits and reorders is applied to one replica.
  Its updates are then applied to two new replicas, one in order, one reversed, and one shuffled.
  All three end with the same objects.
- Concurrent edits to different fields of one object both survive.
- Concurrent edits to different parts of one text merge.
- A deletion and an edit of the same object converge to deleted.
- Concurrent reorders and concurrent inserts at the same position converge.

`doc/model.test.ts` checks the storage layout, round trips for every object type, dense `z` values,
rejection of operations that do not fit, and malformed entries (which are reported, not thrown).

## Known limits

- **No networking.** Updates are produced by `onLocalUpdate` and consumed by `applyRemote`. The
  transport is still to be built.
- **No persistence.** Nothing is written to the database. A reload starts with an empty document.
- **No garbage collection of deleted objects.** Yjs keeps tombstones, so the document grows with
  the history of edits. Snapshots and compaction belong with the persistence work.
- **Array fields are last writer wins.** Pen points and the arrow and line end points change as a
  whole, so two people editing one object's geometry at once will lose one edit.
- **Z-order ties are possible under concurrency** until the next local write renumbers them.
- **Invalid remote entries are skipped, not repaired.** A malformed entry is reported by
  `invalidIds()` and by `consistencyProblems`, and the editor does not show it. Nothing rejects it
  at the source yet.
- **Undo across sessions is not defined.** Undo history lives in memory for the open page.
- **Nothing has been run in this environment.** The Yjs dependency could not be installed, so the
  tests and the model are unverified against the real library.
