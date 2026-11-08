# Canvas and editing

The whiteboard editor is a local, single-user canvas built on react-konva. It opens from a board on
the dashboard. Nothing is saved or synchronized yet: the document lives in the editor and is lost
when the page is left.

## Data model

The document is an ordered list of objects, defined in `packages/shared/src/canvas.ts`. The same
zod schemas validate objects on the client and any future server.

| Type        | Fields (besides `id`, `x`, `y`, `stroke`, `strokeWidth`)                |
| ----------- | ----------------------------------------------------------------------- |
| `pen`       | `points`: at least 2 points, relative to `x`, `y`                       |
| `rectangle` | `width`, `height`, optional `fill`                                      |
| `ellipse`   | `width`, `height` (the bounding box), optional `fill`                   |
| `line`      | `dx`, `dy`: end point relative to `x`, `y`                              |
| `arrow`     | `dx`, `dy`: as for `line`, drawn with a head at the end                 |
| `text`      | `text` (up to 5000 characters), `fontSize`; `stroke` is the text colour |

- **IDs.** Every object has a UUID `id`, generated when the object is created. IDs are stable: they
  do not change when an object moves, resizes, or is edited, and selection refers to them.
- **World coordinates.** `x` and `y` are in world units. The zoom and pan state (the viewport) is
  never stored in an object, so a document renders the same at any zoom level.
- **Relative geometry.** Points and end points are relative to the object's origin, so moving an
  object changes only `x` and `y`.

### Serialization

```ts
import { parseCanvasDocument, serializeCanvasDocument } from '@inkroom/shared';

const json = serializeCanvasDocument(objects); // validates first, then emits { version, objects }
const document = parseCanvasDocument(json); // throws ZodError on invalid input
```

The format is `{ "version": 1, "objects": [...] }`. Parsing rejects unknown object types, non-finite
numbers (JSON cannot represent them), malformed colours, out-of-range values, duplicate ids and
unsupported versions.

## Editing operations

Every change to the document is an operation on objects addressed by id. The operations are
defined in `packages/shared/src/canvas-operations.ts` and are written to the Yjs document by
`apps/web/src/canvas/doc/model.ts`:

| Operation | Meaning                                                                             |
| --------- | ----------------------------------------------------------------------------------- |
| `insert`  | Add objects at an index in the z-order                                              |
| `remove`  | Remove objects by id                                                                |
| `update`  | Change named fields of one object (`x`, `width`, `text`, ...), validated as a whole |
| `reorder` | Give the full new z-order as a permutation of the current ids                       |

`applyOperations(objects, operations)` is pure and throws `OperationError` on anything that does
not fit the document. `diffDocuments(before, after)` produces the operations that turn one document
into another, and `diffDocuments(after, before)` is the inverse. Undo applies the inverse; redo
applies the forward operations.

These are the units that a collaborative session would send and merge. Nothing sends them yet. The
Yjs document receives them, and each batch is one transaction.

## History

The document is a Yjs document, and undo and redo use `Y.UndoManager`. The steps below describe
what the user sees. The mechanism is in [yjs-document.md](yjs-document.md).

Each undoable step is one or more local transactions.

- A pointer drag (move, resize, or drawing a shape or stroke) is one step, recorded on release.
  A click that moves nothing records nothing.
- A text session is one step, from the moment editing starts until it ends, however many
  characters were typed. An empty new text object leaves no trace.
- Delete, paste, duplicate, cut, nudge, and layer changes are each one step.
- A new local change discards the redo steps.
- Remote changes are never undone by the local user, and they are not undo steps for this user.
- Undo or redo during a drag cancels the drag first. The next press undoes a step.
- Keyboard commands and toolbar buttons end an active text session and cancel an active drag
  before they act, so they always work on the committed document.

## Selection and transforms

- **Selection.** Click an object to select it. Shift-click adds or removes it. Drag on empty space
  for a marquee, which selects everything it touches. Ctrl/Cmd+A selects all. Escape clears the
  selection.
- **Bounding box.** The selection's box encloses the objects' own geometry, without stroke padding.
  It is drawn with eight handles: four corners and four edge midpoints.
- **Resizing.** Drag a handle to move its edges. The opposite edges stay put, and no side can
  shrink below one world unit. Handles take priority over objects underneath them.
- **Grouped transforms.** A selection is one group. Dragging moves every selected object by the
  same amount, and resizing scales every object relative to the box. Each object type is mapped
  from the old box to the new one in `apps/web/src/canvas/transform.ts`:
  - rectangles and ellipses scale their box;
  - pen points and line end points scale relative to the origin;
  - text keeps its width, since the font decides it, and its font size scales with the height,
    clamped to 6–400.
- **Nudging.** Arrow keys move the selection by one world unit, or ten with Shift.

Groups are transient selections. They are not persistent objects, so they are not saved and do not
survive a deselect.

## Clipboard and duplication

- **Copy** (Ctrl/Cmd+C) stores copies of the selected objects in memory, in z-order.
- **Paste** (Ctrl/Cmd+V) inserts the copies at the top of the z-order, offset by 20 world units.
  Each paste is offset one step further, so repeated pastes do not stack exactly. The pasted
  objects are selected.
- **Duplicate** (Ctrl/Cmd+D) copies the selection in place, offset by 20 world units, and selects
  the copies. The clipboard is unchanged.
- **Cut** (Ctrl/Cmd+X) copies and then deletes.

The clipboard is local to the page. It is not the system clipboard, so it does not carry objects
between browser tabs.

## Layer order

Layer changes reorder the z-order of the selection:

- **Bring forward** and **Send backward** (Ctrl/Cmd+] and Ctrl/Cmd+[) move each selected object past
  the neighbour it would cross. A selected run keeps its internal order.
- **Bring to front** and **Send to back** (Ctrl/Cmd+Shift+] and Ctrl/Cmd+Shift+[) move the whole
  selection to the top or bottom, keeping its internal order.

Front and back are available as keyboard shortcuts only. The toolbar offers forward and backward.

## Coordinate transforms

`apps/web/src/canvas/viewport.ts` holds the viewport, `{ scale, offsetX, offsetY }`, with
`screen = world * scale + offset`.

- `screenToWorld` and `worldToScreen` are exact inverses. Pointer positions are converted to world
  space once, in the editor reducer, and everything after that works in world units.
- `zoomAt` keeps the world point under the anchor fixed. Zoom buttons anchor at the centre of the
  canvas, and wheel and pinch anchor at the pointer.
- `worldLength` turns screen pixels into world units, so hit slop (6 px), handle size (8 px), and
  minimum pen spacing (1.5 px) feel the same at every zoom level.
- Scale is clamped to 0.1 to 8.

Konva is given the same viewport as the stage transform, so drawing and hit testing agree. Nodes
are set to `listening={false}`, so all pointer handling goes through the editor.

## Keyboard and pointer

| Input                                 | Action                                                         |
| ------------------------------------- | -------------------------------------------------------------- |
| Toolbar, or V H P R O L A T           | Select, Hand (pan), Pen, Rectangle, Ellipse, Line, Arrow, Text |
| Drag on an object with Select         | Move it, with the rest of the selection                        |
| Drag a selection handle               | Resize the selection                                           |
| Drag on empty space with Select       | Marquee selection                                              |
| Shift + click                         | Add to or remove from the selection                            |
| Click on empty space                  | Clear the selection                                            |
| Drag with Pen or a shape tool         | Draw; releasing creates the object (clicks create nothing)     |
| Click with Text                       | Create a text object and start typing                          |
| Double-click a text object            | Edit its text                                                  |
| Ctrl/Cmd + Z                          | Undo                                                           |
| Ctrl/Cmd + Shift + Z, or Ctrl/Cmd + Y | Redo                                                           |
| Ctrl/Cmd + A                          | Select all                                                     |
| Ctrl/Cmd + C, X, V, D                 | Copy, cut, paste, duplicate                                    |
| Ctrl/Cmd + ], [                       | Bring forward, send backward                                   |
| Ctrl/Cmd + Shift + ], [               | Bring to front, send to back                                   |
| Arrow keys, Shift + arrow keys        | Nudge the selection by 1 or 10 world units                     |
| Delete or Backspace                   | Delete the selection                                           |
| Escape                                | Clear the selection (or leave text editing)                    |
| Hold Space, middle button, or Hand    | Pan                                                            |
| Two-finger drag                       | Pan and pinch-zoom                                             |
| Wheel or two-finger trackpad scroll   | Pan                                                            |
| Ctrl/Cmd + wheel or trackpad pinch    | Zoom around the pointer                                        |
| Zoom in / Zoom out / Reset view       | Zoom by 25 % steps, or return to 100 % at the origin           |

Mouse and touch input both use pointer events. The canvas sets `touch-action: none` so the browser
does not scroll or zoom the page during a gesture. The wheel listener is attached directly with
`passive: false`, because React's wheel listener cannot prevent default. Wheel input is mapped by
modifier key: Ctrl or Meta zooms, and anything else pans.

The toolbar status line (`role="status"`) reports the object count and, when something is selected,
its size and position. Screen readers announce it after each change.

## Testing

Unit tests:

- `packages/shared/src/canvas.test.ts`: serialization round trips and rejection of invalid input.
- `packages/shared/src/canvas-operations.test.ts`: applying each operation, rejection of operations
  that do not fit, the operation schema, and `diffDocuments` round trips, including seeded random
  edit sequences that check every intermediate document in both directions.
- `apps/web/src/canvas/viewport.test.ts`: coordinate round trips, anchor-stable zoom, wheel and pinch
  behaviour, and clamping.
- `apps/web/src/canvas/geometry.test.ts`: bounds, hit testing for each type, topmost picking, and
  marquee intersection.
- `apps/web/src/canvas/transform.test.ts`: selection bounds, handle positions and hits, resizing
  rules, and the scaling of each object type between boxes.
- `apps/web/src/canvas/history.test.ts`: recording, undo, redo, and discarding of redo steps.
- `apps/web/src/canvas/status.test.ts`: the status line text.
- `apps/web/src/canvas/doc/model.test.ts`: the Yjs storage layout, round trips for every object type,
  dense z-order values, rejected operations, and malformed entries.
- `apps/web/src/canvas/doc/canvas-document.test.ts`: local undo and redo, step boundaries, remote
  updates staying out of undo, convergence in different orders, and concurrent edits.
- `apps/web/src/canvas/session.test.ts`: the view and the document staying equal after each step,
  and two connected sessions.
- `apps/web/src/canvas/editor.test.ts`: drawing, selection, moving, resizing, group transforms,
  marquee, panning, zooming, text editing, copy and paste, layer order, nudging, undo and redo,
  and interactions between text, freehand strokes and transformations. Includes checks that drawn
  and moved coordinates are the same world values at several zoom levels.
- `apps/web/src/canvas/CanvasEditor.test.tsx`: toolbar, keyboard shortcuts, zoom readout, DOM pointer
  and wheel events, and undo, redo, nudge, duplicate and select-all through the component. The
  Konva scene is mocked (jsdom has no 2D canvas) and records its props.

Browser tests (Playwright, `apps/web/e2e/canvas-editing.spec.ts`, run with `pnpm test:e2e`): each
test registers an account through the UI, creates a board, and drives the canvas with the mouse and
keyboard. The checks cover drawing and nudging with undo and redo, resizing from a handle, deleting
and restoring, duplicating, text editing as one undo step, and freehand strokes. The specs need the
API and PostgreSQL running; `playwright.config.ts` starts both on loopback ports 21080 and 21173.

Not covered automatically: pinch tracking across two real pointers, pointer capture, touch
behaviour, and rendering pixels. The browser tests check the status line rather than the drawn
pixels.

## Limitations

- No collaboration transport. Updates are produced and consumed locally, and no WebSocket exists.
  See [yjs-document.md](yjs-document.md) for the known limits of the document model.
- No persistence. Changes stay on the page and are lost on navigation.
- Objects cannot be rotated, recoloured, or given a fill colour. Colours are fixed (`#1f2328`,
  width 2).
- Resizing does not lock aspect ratio, even with Shift. A selection with no extent on one axis, such
  as a vertical line alone, cannot be resized along that axis.
- Text bounds are estimates, because Konva lays text out with the default font. Multi-line text is
  supported, but wrapping is not, and text scales its font size rather than its width.
- Groups are transient selections, not persistent objects. There is no lock, and no hiding.
- Stroke widths scale with zoom, which keeps the document in world units but means very thin
  strokes can disappear at low zoom.
- Selection and marquee use object bounding boxes, not the exact shape outline.
- Pen input is not smoothed.
- The clipboard is in memory only, not the system clipboard.
- Nothing has been run in this environment: the dependencies could not be installed, so the unit
  and browser tests, type checks and lint are unverified.
