# Canvas and drawing tools

The whiteboard editor is a local, single-user canvas built on react-konva. It opens from a board
on the dashboard. Nothing is saved or synchronized yet: drawing state lives in the editor and is
lost when the page is left.

## Data model

The document is an ordered list of objects, defined in `packages/shared/src/canvas.ts`. The same
zod schemas validate objects on the client and any future server.

| Type        | Fields (besides `id`, `x`, `y`, `stroke`, `strokeWidth`)                  |
| ----------- | ------------------------------------------------------------------------- |
| `pen`       | `points`: at least 2 points, relative to `x`, `y`                        |
| `rectangle` | `width`, `height`, optional `fill`                                       |
| `ellipse`   | `width`, `height` (the bounding box), optional `fill`                    |
| `line`      | `dx`, `dy`: end point relative to `x`, `y`                               |
| `arrow`     | `dx`, `dy`: as for `line`, drawn with a head at the end                  |
| `text`      | `text` (up to 5000 characters), `fontSize`; `stroke` is the text colour  |

- **IDs.** Every object has a UUID `id`, generated when the object is created. IDs are stable: they
  do not change when an object moves or is edited, and selection refers to them.
- **World coordinates.** `x` and `y` are in world units. The zoom and pan state (the viewport) is
  never stored in an object, so a document renders the same at any zoom level.
- **Relative geometry.** Points and end points are relative to the object's origin, so moving an
  object changes only `x` and `y`.

### Serialization

```ts
import { parseCanvasDocument, serializeCanvasDocument } from '@inkroom/shared';

const json = serializeCanvasDocument(objects); // validates first, then emits { version, objects }
const document = parseCanvasDocument(json);    // throws ZodError on invalid input
```

The format is `{ "version": 1, "objects": [...] }`. Parsing rejects unknown object types, non-finite
numbers (JSON cannot represent them), malformed colours, out-of-range values, duplicate ids and
unsupported versions. Serializing an invalid object throws, so bad data is never written.

## Coordinate transforms

`apps/web/src/canvas/viewport.ts` holds the viewport, `{ scale, offsetX, offsetY }`, with
`screen = world * scale + offset`.

- `screenToWorld` and `worldToScreen` are exact inverses. Pointer positions are converted to world
  space once, in the editor reducer, and everything after that works in world units.
- `zoomAt` keeps the world point under the anchor fixed. Zoom buttons anchor at the centre of the
  canvas, and wheel and pinch anchor at the pointer.
- `worldLength` turns screen pixels into world units, so hit slop (6 px) and minimum pen spacing
  (1.5 px) feel the same at every zoom level.
- Scale is clamped to 0.1 to 8.

Konva is given the same viewport as the stage transform, so drawing and hit testing agree. Nodes
are set to `listening={false}`, so all pointer handling goes through the editor.

## Controls

| Input                              | Action                                                     |
| ---------------------------------- | ---------------------------------------------------------- |
| Toolbar, or V H P R O L A T        | Select, Hand (pan), Pen, Rectangle, Ellipse, Line, Arrow, Text |
| Drag with Select on an object      | Move it (and the rest of the selection)                    |
| Drag on empty space with Select    | Marquee selection                                          |
| Shift + click                      | Add to or remove from the selection                        |
| Click on empty space               | Clear the selection                                        |
| Drag with Pen or a shape tool      | Draw; releasing creates the object (clicks create nothing) |
| Click with Text                    | Create a text object and start typing                      |
| Double-click a text object         | Edit its text                                              |
| Delete or Backspace                | Delete the selection                                       |
| Escape                             | Clear the selection (or leave text editing)                |
| Hold Space, middle button, or Hand | Pan                                                        |
| Two-finger drag                    | Pan and pinch-zoom                                         |
| Wheel or two-finger trackpad scroll | Pan                                                       |
| Ctrl/Cmd + wheel or trackpad pinch | Zoom around the pointer                                    |
| Zoom in / Zoom out / Reset view    | Zoom by 25 % steps, or return to 100 % at the origin       |

Mouse and touch input both use pointer events. The canvas sets `touch-action: none` so the browser
does not scroll or zoom the page during a gesture. The wheel listener is attached directly with
`passive: false`, because React's wheel listener cannot prevent default. Wheel input is mapped by
modifier key: Ctrl or Meta zooms, and anything else pans. Some mice do not distinguish these from
trackpad input, so a mouse wheel without Ctrl pans rather than zooms.

## Testing

- `packages/shared/src/canvas.test.ts`: serialization round trips for every type, and rejection of
  invalid input.
- `apps/web/src/canvas/viewport.test.ts`: coordinate round trips at several zoom levels and offsets,
  anchor-stable zoom, wheel and pinch behaviour, and scale clamping.
- `apps/web/src/canvas/geometry.test.ts`: bounds, hit testing for each type, topmost picking, and
  marquee intersection.
- `apps/web/src/canvas/editor.test.ts`: drawing, selection, moving, marquee, panning, zooming and
  text editing, driven through the reducer. Includes checks that drawn and moved coordinates are
  the same world values at several zoom levels.
- `apps/web/src/canvas/CanvasEditor.test.tsx`: toolbar, keyboard shortcuts and zoom readout, plus
  DOM pointer and wheel events dispatched to the real component. The Konva scene is mocked (jsdom
  has no 2D canvas) and records its props, so tests can check the resulting document.

The reducer tests drive pointer sequences with screen coordinates. The component tests dispatch
`MouseEvent` and `WheelEvent` objects named `pointerdown`, `pointermove`, `pointerup` and `wheel`,
because jsdom has no `PointerEvent`. They cover the surface's event wiring, Ctrl + wheel zoom,
plain-wheel pan, and drawing after zooming. Not covered: pinch tracking across two real pointers,
pointer capture against the browser, and touch-action behaviour. Those need a browser test.

## Limitations

- No undo or redo.
- No persistence and no network synchronization. Changes stay on the page.
- Objects can be moved and deleted but not resized, rotated, recoloured, or restacked. Colours
  are fixed (`#1f2328`, width 2), and there is no fill colour picker.
- Text bounds are estimates, since Konva lays text out with the default font. Multi-line text is
  supported, but wrapping is not.
- Stroke widths scale with zoom, which keeps the document in world units but means very thin
  strokes can disappear at low zoom.
- Selection and marquee use object bounding boxes, not the exact shape outline.
- Pen input is not smoothed.
