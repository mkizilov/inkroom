# Rendering performance

This page records what was measured on the canvas, how it was measured, and what changed. The
benchmarks are in `apps/web/bench/`, and every number here comes from them.

## Summary

- On a 5,000-object board, marquee selection is about 9× faster, selecting every object is 160 to
  230× faster, and picking is about 5.6× faster. These were measured in the pure canvas code, against
  the frozen code they replaced, in the same run.
- The scene draws only what is on screen, plus a 64-unit margin. On a 5,000-object board in a
  1280×800 view at 1×, it draws 35 nodes instead of 5,000.
- Frame time, React re-renders, Yjs transactions, network frequency and snapshot loading were **not
  measured** in this environment. They are listed under "Not measured" below.

## Environment

- Apple M4 (10 cores), 16 GB, macOS, arm64.
- Node v26.13.0. The package's engines field is `>=22.9` and `.nvmrc` pins 22, so these numbers are
  not from Node 22.
- Dependencies could not be installed here (the package registry was unreachable). Only the pure
  canvas modules were measured. They import no installed package at runtime.

## Method

- Each row runs the same operation on the frozen reference (`bench/reference.ts`, the code as of
  commit `67ecc26`) and on the live code, in the same process.
- Variants alternate round by round, with 3 warm-up and 21 measured rounds. The results below are medians.
  p95 is in the raw output.
- Before timing, the runner checks that the live results equal the reference, and exits with code 1
  if they do not. It checks object bounds for 1,000 objects, marquee selection over 20 windows,
  picks at 300 fixed points plus object centres and stroke-edge points for the first 300 objects, and
  culling at two zoom levels (no object on screen may be dropped).
- Fixtures come from a fixed seed (`bench/fixtures.ts`): a grid with one object per cell, a mix of all
  object types, and pen strokes of 10 to 120 points.
- Between sessions the same reference row moved by up to about 30% (selection: 152 ms in the baseline
  session, 102 to 108 ms later). Compare rows within one run, not across runs.

## Results

"Before" is a baseline run of the pre-change code. "After" is three runs of the final code. "Ratio" is
the reference divided by the live code, measured in the same final run.

- **Marquee, 50 moves over 5,000 objects.** Before 57.9 ms. After 6.4 to 6.7 ms. Ratio about 9×
  (reference 57.8 to 60.7 ms in the same runs).
- **Selection lookup, all 5,000 selected.** Before 152.5 ms. After 0.46 to 0.64 ms. Ratio about 160 to
  230× (reference 103.8 to 108.1 ms).
- **Pick, 200 points over 5,000 objects.** Before 186.8 ms. After 33.1 to 33.8 ms. Ratio about 5.6×
  (reference 187.6 to 189.5 ms). That is about 0.17 ms per pick.
- **Object bounds with no cached values, 1,000 objects.** Live 0.16 to 0.27 ms against a reference of
  0.49 to 0.60 ms (2 to 3×).
- **Object bounds with no cached values, 5,000 objects.** Live 0.83 to 1.29 ms against 1.56 to 1.73 ms
  (1.3 to 1.9×). This row builds new objects every round, so it measures uncached work. The cache shows
  up in the marquee and selection rows.

### Nodes drawn

Measured at a 1280×800 view, with nothing selected:

- 1,000 objects at 1×: 1,000 drawn before, 31 after.
- 1,000 objects at 0.25×: 1,000 before, 377 after.
- 5,000 objects at 1×: 5,000 before, 35 after.
- 5,000 objects at 0.25×: 5,000 before, 379 after.

Planning the scene takes 0.02 to 0.03 ms at 1,000 objects and 0.12 to 0.16 ms at 5,000. The
"reference" time in the scene rows (0.01 to 0.04 ms) only filters the list and draws nothing. It is
not a comparison of render time, and the node counts are the measure that culling changes. Time to
draw those nodes was not measured.

At 1× culling removes 97 to 99% of the nodes. At 0.25× a 1,000-object board still draws 377 nodes,
because the view covers about a third of it.

## What changed

1. **Cached object extents** (`apps/web/src/canvas/geometry.ts`). An object's own extent is computed
   once and kept, frozen, against the object's identity. The pen extent is computed in one pass with no
   array allocation. Every caller only reads extents (render, marquee, hit testing, the presence
   overlay and the region export), and a write would now throw. None was found.
   The cache relies on identity. The editor keeps the objects an action does not change, so it stays
   warm during drags, marquee moves and selection. A remote change rebuilds every object, so the first
   render after it is cold; the "no cached bounds" rows measure that case.
2. **Pen hit test** (`geometry.ts`). A bounds check runs first, so most strokes are rejected without
   measuring every segment. The check is exact: no point of a stroke lies farther than the reach outside
   its bounds, and the boundary test is inclusive.
3. **Scene plan** (`apps/web/src/canvas/scene-plan.ts`, new). It decides what to draw: objects that
   touch the view plus a 64-unit margin. A stroke reaches at most 32 units past its bounds (the schema
   allows stroke widths up to 64), and arrowheads stay inside that. Selection is looked up through a
   set. The text box being edited is left out of the drawing but keeps its outline, as before.
   Text culling assumes one em per character, so text is not cut early.
4. **Scene rendering** (`apps/web/src/canvas/CanvasScene.tsx`). It draws the plan. The same objects are
   drawn in the same order inside the view.

Nothing else changed. The reducer, Yjs transactions, network frames and the server are untouched.
Visible behavior should be the same, but the rendering has not been compared in a browser.

## Equivalence checks

The runner's checks passed on all six runs made with the pick check in place: three before and three
after the runner was rewritten, which kept the same checks. The culling check runs at 2 zoom levels
and confirms that no on-screen object is dropped.
The unit tests in `apps/web/src/canvas/scene-plan.test.ts` (new) cover the margin, zoom and pan,
stacking order, the hidden text box and long text at the edge. They have not been run, because
`vitest` needs the installed dependencies.

## Not measured

- **Frame time and Konva rendering.** Needs a browser.
- **React re-renders.** Not profiled. The editor re-renders on each state change, and the scene plan
  now runs on each render (0.02 to 0.16 ms).
- **Pointer event frequency.** Each pointer move dispatches one editor action, and each action is one
  Yjs transaction, so a 60-move drag produces 60 Yjs updates. `bench/document.bench.ts` prints this
  count. It was not run here.
- **Yjs transaction batching, network update frequency and snapshot loading.** `bench/document.bench.ts`
  measures a single write, a snapshot, encoding the state and the editor actions. It needs
  `pnpm install` and was not run here.
- **Object diffing.** Each change to the object list runs `diffDocuments` in `apps/web/src/canvas/editor.ts`.
  Its cost has not been measured.

## Remaining bottlenecks

- **Picking is linear in the number of objects.** It costs about 0.17 ms per pick at 5,000 objects.
  Rectangles, lines and arrows are tested without a bounds check, and their tests allocate arrays.
- **Low zoom shows much of the board.** At 0.25× culling saves little: 377 of 1,000 objects are drawn.
- **Each pointer move is its own Yjs update and network frame.** Coalescing moves per animation frame
  is the next candidate. It changes timing, so it needs a browser test before it is merged.
- **Text culling assumes one em per character.** Wider glyphs (some emoji, and some scripts in some
  fonts) can extend past the estimated box, so text just outside the view could be cut early.

## Reproducing

- `pnpm --filter @inkroom/web bench:geometry` runs the pure-code benchmarks, with no installed
  dependencies. It needs Node 22.15 or later, for `module.registerHooks`. The engines field says
  `>=22.9`, so older 22.x releases will fail to start the script. Pass `--json=<path>` to save the results.
- `pnpm --filter @inkroom/web bench` runs the document benchmarks, after `pnpm install`.
- `bench/reference.ts` holds the pre-change code used for comparison. Do not change it.
