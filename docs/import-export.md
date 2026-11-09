# Import and export

A board can be exported as a PNG picture, an SVG drawing, or a versioned JSON file, for the whole
board, the selected objects, or a region. A JSON file can be imported as a new board. Export runs in
the browser, from the board as it is on screen. Import checks the file in the browser and again on the
server before anything is stored.

## Exporting

Use **Export** on the board page. The panel offers three scopes:

- **Whole board** exports every object, with a 20-unit margin around them.
- **Selected objects** exports the objects selected on the canvas, with the same margin. It is
  enabled only when something is selected.
- **Region** exports the objects that touch a rectangle given in board units (X, Y, Width, Height).
  A line, arrow or pen touches it when its drawn stroke reaches it: the stroke has round ends, so it
  reaches every point within half its width of its path, and an arrowhead counts as its filled triangle.
  A rectangle, ellipse or text touches it when its box does. Each object that touches the region is
  exported whole, so nothing is cut in the file.

Each scope can be downloaded as JSON, SVG or PNG. The PNG scale (1×, 2× or 3×) applies to PNG only.
Files are named after the board title and the scope, such as `sprint-4-region.svg`.

### Coordinates and layers

Objects keep their board coordinates in every format:

- **JSON** stores each object's `x`, `y` and its size or end point exactly as on the board.
- **SVG** uses the exported area as its `viewBox`. An object at `x = 300` is drawn at `x = 300` of the
  picture's coordinate system, so the picture lines up with the board.
- **PNG** is the SVG drawn onto a canvas at the chosen scale. It has the same layout.

Objects are written back to front. In JSON that is the order of the `objects` array; in SVG it is the
order of the elements, so later objects are drawn over earlier ones. Import keeps the order.

The object model has no rotation or flip. Position, size, end points, pen points and stacking order
are everything a transform can change, and all of them are kept.

## The JSON format

```json
{
  "format": "inkroom.board",
  "version": 1,
  "title": "Sprint planning",
  "exportedAt": "2026-01-02T09:30:00.000Z",
  "region": null,
  "objects": [
    {
      "id": "0b7c4a2e-6f1d-4c8a-9e3b-2a1f5d7c9e10",
      "type": "rectangle",
      "x": 40,
      "y": 40,
      "width": 200,
      "height": 120,
      "stroke": "#1971c2",
      "strokeWidth": 2,
      "fill": "#a5d8ff"
    }
  ]
}
```

- `format` is always `inkroom.board`, and `version` is `1`. A reader accepts only the versions it
  knows, so a file from a later version is refused with the version it uses.
- `region` is `null` for a whole-board export, and the exported area otherwise. It is recorded for the
  reader; an import always keeps the objects where they are.
- `objects` holds the object types of the canvas: `pen`, `rectangle`, `ellipse`, `line`, `arrow` and
  `text`. The fields of each type are those of the canvas model (`packages/shared/src/canvas.ts`).
- The schema is strict at the top level: an unknown top-level field is refused. Unknown fields inside
  an object are ignored.

The schema lives in `packages/shared/src/board-export.ts`. The browser and the server both use it.

## Importing

Use **Import a board file** on the dashboard and choose a JSON file. The board is created for the
signed-in user, with the file's title, and it opens at once. Its objects keep the ids and coordinates
of the file, in the file's order.

Import always creates a new board. It does not merge into a board that already exists.

A file is refused, and nothing is created, when:

- it is larger than 8 MB;
- its text is not JSON;
- its version is not one this InkRoom reads;
- it does not match the schema: a wrong format, a missing field, an unknown object type, a colour that
  is not `#rrggbb`, a blank or over-long title, duplicate object ids, or more than 10,000 objects.

The browser reports the reason. The server applies the same checks and answers `400` (or `413` for a
body over the limit) with the same kind of message.

## Limits

- **File size (import and export):** 8 MB. The browser checks it before reading a file, and the
  server checks the request body before parsing it.
- **Objects per board:** 10,000, checked on import and on export.
- **Points per pen:** 10,000.
- **Characters per text object:** 5,000.
- **PNG size:** 25 million pixels, checked before drawing (for example 5,000 × 5,000 at 1×).
- **Stored update per batch:** about 256 KB. The server batches imported objects, so each stored row
  stays under 1 MiB.

An export larger than 8 MB is refused with a message that suggests a region or a selection, so every
export can be imported again.

## Security

- Every value written into SVG is escaped (`escapeXml` in `apps/web/src/export/svg.ts`), including text
  content, names and colours. A text object cannot add markup to an exported picture.
- The import route checks the request's origin like the other writes, requires a session, and limits
  the body before parsing it.
- The export is made in the browser from the board already open, so it adds no server endpoint and no
  access beyond what the board page shows. Viewers can export; export does not change the board.

## Limitations

- **Region edges for shapes.** A rectangle or ellipse is judged by its box, so an unfilled shape that
  surrounds the region is exported even though its outline does not reach the region. Strokes are
  judged by their drawn path, as described above.
- **Arrow ends.** The canvas draws an arrow's shaft with a flat end, and the export draws it with a round
  end. A region can therefore differ at an arrow's tip by up to half the stroke width.
- **Text.** SVG and PNG draw text with the viewer's `sans-serif` font, at the same size and with lines
  spaced by the font size. Glyph widths can differ slightly from the canvas. A text object's bounds
  for selection and for a region are estimated from its character count, so a region export can
  include or leave out a text object at its edge differently from what the eye expects.
- **Imported copies.** Importing the same file twice creates two boards. The objects have the same ids
  in each, because ids are kept.
- **Versions.** Only version 1 is read. A file from a later version needs a later InkRoom.
- **Synced state.** The export is what is on screen. A board opened offline exports its local copy, and
  changes that have not synced yet are included.
- **PNG on very large regions** is refused rather than drawn, to stay within what browsers can draw.
- **Not verified here.** The browser tests in `apps/web/e2e/import-export.spec.ts`, and the database
  import test in `apps/api/src/boards/import.integration.test.ts`, have not been run in this
  environment. See the commit message for what was and was not verified.

## Tests

- `packages/shared/src/board-export.test.ts`: JSON round trips for every object type (coordinates,
  text, order), a stable second serialization, regions, and refusals (version, format, unknown type,
  colour, title, duplicate ids, too many objects, malformed text).
- `apps/api/src/boards/import.test.ts`: the import updates rebuild the objects in order, and a large
  board is split into updates that each stay under the stored limit.
- `apps/api/src/boards/import.integration.test.ts` (needs `TEST_DATABASE_URL`): an import creates an
  owned board with the same objects in the same order; a version it does not read, malformed text,
  too many objects, an oversized body, an anonymous request and a cross-site request are refused, and
  refusals create nothing.
- `apps/web/src/export/*.test.ts`: region selection, the SVG coordinates and transforms, arrowheads,
  text escaping, stacking order, the JSON round trip through the shared reader, the import and PNG
  limits, and file names.
- `apps/web/src/boards/board-file.test.ts`: the checks the browser makes before sending a file.
- `apps/web/e2e/import-export.spec.ts` (Playwright, needs the API and PostgreSQL): importing a
  representative board, exporting its JSON, SVG and PNG, a region export, and refusals for a wrong
  format and a later version.
