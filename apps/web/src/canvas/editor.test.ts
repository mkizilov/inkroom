import { describe, expect, it } from 'vitest';
import { MAX_TEXT_LENGTH, type CanvasObject, type Point } from '@inkroom/shared';
import {
  PASTE_OFFSET,
  createEditorState,
  editorReducer,
  type EditorAction,
  type EditorState,
} from './editor';
import { MAX_HISTORY } from './history';
import { screenToWorld, worldToScreen, type Viewport } from './viewport';

const style = { stroke: '#1f2328', strokeWidth: 2 };
const idOf = (value: string) => `00000000-0000-4000-8000-00000000000${value}`;
const uniqueId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function run(state: EditorState, ...actions: EditorAction[]): EditorState {
  return actions.reduce(editorReducer, state);
}

function withView(viewport: Viewport, objects: CanvasObject[] = []): EditorState {
  return { ...createEditorState(), viewport, objects };
}

const press = (screen: Point, id = idOf('a'), shift = false): EditorAction => ({
  type: 'pointerDown',
  screen,
  button: 0,
  shift,
  id,
});
const move = (screen: Point): EditorAction => ({ type: 'pointerMove', screen });
const release: EditorAction = { type: 'pointerUp' };
const select = (screen: Point, shift = false): EditorAction[] => [
  press(screen, idOf('s'), shift),
  release,
];

const rectangle = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): CanvasObject => ({
  id: idOf(id),
  type: 'rectangle',
  x,
  y,
  width,
  height,
  ...style,
});

function idsOf(state: EditorState): string[] {
  return state.objects.map((object) => object.id);
}

describe('drawing tools', () => {
  it('draws a pen stroke whose points are stored in world units at zoom 2', () => {
    const state = run(
      withView({ scale: 2, offsetX: 100, offsetY: 50 }, []),
      { type: 'setTool', tool: 'pen' },
      press({ x: 120, y: 70 }),
      move({ x: 140, y: 70 }),
      release,
    );

    expect(state.objects).toHaveLength(1);
    expect(state.objects[0]).toMatchObject({
      type: 'pen',
      x: 10,
      y: 10,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    });
    expect(state.selectedIds).toEqual([idOf('a')]);
  });

  it('draws a rectangle dragged up and left at zoom 0.5 with the right world box', () => {
    const state = run(
      withView({ scale: 0.5, offsetX: 0, offsetY: 0 }),
      { type: 'setTool', tool: 'rectangle' },
      press({ x: 100, y: 100 }),
      move({ x: 50, y: 60 }),
      release,
    );

    expect(state.objects[0]).toMatchObject({
      type: 'rectangle',
      x: 100,
      y: 120,
      width: 100,
      height: 80,
    });
  });

  it('draws ellipses, lines and arrows from their start point to the drag end', () => {
    const base = withView({ scale: 1, offsetX: 0, offsetY: 0 });
    const drag = (tool: 'ellipse' | 'line' | 'arrow', end: Point) =>
      run(base, { type: 'setTool', tool }, press({ x: 10, y: 10 }), move(end), release);
    const ellipse = drag('ellipse', { x: 60, y: 40 });
    const line = drag('line', { x: 40, y: 50 });
    const arrow = drag('arrow', { x: 40, y: 50 });

    expect(ellipse.objects[0]).toMatchObject({
      type: 'ellipse',
      x: 10,
      y: 10,
      width: 50,
      height: 30,
    });
    expect(line.objects[0]).toMatchObject({ type: 'line', x: 10, y: 10, dx: 30, dy: 40 });
    expect(arrow.objects[0]).toMatchObject({ type: 'arrow', x: 10, y: 10, dx: 30, dy: 40 });
  });

  it('discards shapes and strokes that were only clicked', () => {
    const base = withView({ scale: 1, offsetX: 0, offsetY: 0 });
    const clicked = run(
      base,
      { type: 'setTool', tool: 'rectangle' },
      press({ x: 5, y: 5 }),
      release,
    );
    const dotted = run(base, { type: 'setTool', tool: 'pen' }, press({ x: 5, y: 5 }), release);

    expect(clicked.objects).toHaveLength(0);
    expect(dotted.objects).toHaveLength(0);
  });

  it('shows the in-progress shape as a draft until the pointer is released', () => {
    const drawing = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }),
      { type: 'setTool', tool: 'rectangle' },
      press({ x: 0, y: 0 }),
      move({ x: 30, y: 20 }),
    );

    expect(drawing.draft).toMatchObject({ type: 'rectangle', width: 30, height: 20 });
    expect(drawing.objects).toHaveLength(0);
    expect(run(drawing, release).draft).toBeNull();
  });

  it('cancels a draft without creating an object', () => {
    const cancelled = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }),
      { type: 'setTool', tool: 'pen' },
      press({ x: 0, y: 0 }),
      move({ x: 30, y: 20 }),
      { type: 'pointerCancel' },
    );

    expect(cancelled.draft).toBeNull();
    expect(cancelled.objects).toHaveLength(0);
  });

  it('keeps drawn coordinates accurate across zoom levels', () => {
    for (const scale of [0.25, 1, 4]) {
      const viewport = { scale, offsetX: 13, offsetY: -7 };
      const start = worldToScreen({ x: 40, y: 30 }, viewport);
      const end = worldToScreen({ x: 140, y: 90 }, viewport);
      const state = run(
        withView(viewport),
        { type: 'setTool', tool: 'rectangle' },
        press(start),
        move(end),
        release,
      );
      expect(state.objects[0]).toMatchObject({ x: 40, y: 30, width: 100, height: 60 });
    }
  });
});

describe('selection and movement', () => {
  it('selects the topmost object under the pointer and moves it in world units', () => {
    const state = run(
      withView({ scale: 2, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 100, 100)]),
      press({ x: 0, y: 50 }),
      move({ x: 40, y: 50 }),
      release,
    );

    expect(state.selectedIds).toEqual([idOf('1')]);
    expect(state.objects[0]).toMatchObject({ x: 20, y: 0 });
  });

  it('moves selected objects by the same world distance at every zoom level', () => {
    for (const scale of [0.25, 1, 4]) {
      const viewport = { scale, offsetX: -40, offsetY: 9 };
      // Unfilled shapes are only hit on their outline, so grab the left edge.
      const grab = worldToScreen({ x: 0, y: 50 }, viewport);
      const state = run(
        withView(viewport, [rectangle('1', 0, 0, 100, 100)]),
        press(grab),
        move({ x: grab.x + 10 * scale, y: grab.y }),
        release,
      );
      expect(state.objects[0]?.x).toBeCloseTo(10, 9);
      expect(state.objects[0]?.y).toBeCloseTo(0, 9);
    }
  });

  it('toggles objects in and out of the selection with Shift', () => {
    const view = withView({ scale: 1, offsetX: 0, offsetY: 0 }, [
      rectangle('1', 0, 0, 50, 50),
      rectangle('2', 100, 0, 50, 50),
    ]);
    const state = run(
      view,
      press({ x: 0, y: 10 }, idOf('x')),
      release,
      press({ x: 100, y: 10 }, idOf('x'), true),
      release,
      press({ x: 0, y: 10 }, idOf('x'), true),
      release,
    );

    expect(state.selectedIds).toEqual([idOf('2')]);
  });

  it('clears the selection when clicking empty space', () => {
    const selected = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 50, 50)]),
      press({ x: 0, y: 10 }),
      release,
    );
    expect(selected.selectedIds).toEqual([idOf('1')]);

    const cleared = run(selected, press({ x: 500, y: 500 }), release);
    expect(cleared.selectedIds).toEqual([]);
  });

  it('selects every object a marquee touches', () => {
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [
        rectangle('1', 0, 0, 50, 50),
        rectangle('2', 100, 100, 50, 50),
        rectangle('3', 300, 300, 50, 50),
      ]),
      press({ x: -10, y: -10 }),
      move({ x: 160, y: 160 }),
    );

    expect(state.marquee).toEqual({ x: -10, y: -10, width: 170, height: 170 });
    expect(state.selectedIds).toEqual([idOf('1'), idOf('2')]);
    expect(run(state, release).marquee).toBeNull();
  });

  it('clears the selection when the tool changes', () => {
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 50, 50)]),
      press({ x: 0, y: 10 }),
      release,
      { type: 'setTool', tool: 'rectangle' },
    );

    expect(state.selectedIds).toEqual([]);
  });
});

describe('viewport interaction', () => {
  it('pans with the hand tool without moving objects', () => {
    const rect = rectangle('1', 0, 0, 50, 50);
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rect]),
      { type: 'setTool', tool: 'pan' },
      press({ x: 10, y: 10 }),
      move({ x: 30, y: 50 }),
      release,
    );

    expect(state.viewport).toEqual({ scale: 1, offsetX: 20, offsetY: 40 });
    expect(state.objects).toEqual([rect]);
  });

  it('pans while Space is held, even over an object', () => {
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 50, 50)]),
      { type: 'setSpaceHeld', held: true },
      press({ x: 10, y: 10 }),
      move({ x: 0, y: 15 }),
      release,
    );

    expect(state.selectedIds).toEqual([]);
    expect(state.viewport.offsetY).toBe(5);
  });

  it('pans with the middle mouse button', () => {
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }),
      { type: 'pointerDown', screen: { x: 0, y: 0 }, button: 1, shift: false, id: idOf('a') },
      move({ x: 12, y: 3 }),
      release,
    );

    expect(state.viewport).toEqual({ scale: 1, offsetX: 12, offsetY: 3 });
  });

  it('zooms around an anchor so the world point under it does not move', () => {
    const before = withView({ scale: 1, offsetX: 30, offsetY: -20 });
    const anchor = { x: 100, y: 100 };

    const after = run(before, { type: 'zoom', factor: 2, anchor });

    expect(after.viewport.scale).toBe(2);
    expect(screenToWorld(anchor, after.viewport)).toEqual(screenToWorld(anchor, before.viewport));
  });

  it('applies wheel input to the latest viewport so back-to-back events accumulate', () => {
    const anchor = { x: 0, y: 0 };
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }),
      { type: 'wheel', anchor, input: { deltaX: 0, deltaY: -100, zoom: true } },
      { type: 'wheel', anchor, input: { deltaX: 0, deltaY: -100, zoom: true } },
    );

    expect(state.viewport.scale).toBeCloseTo(Math.exp(2), 9);
  });

  it('pans with plain wheel input from the latest viewport', () => {
    const anchor = { x: 0, y: 0 };
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }),
      { type: 'wheel', anchor, input: { deltaX: 0, deltaY: 30, zoom: false } },
      { type: 'wheel', anchor, input: { deltaX: 0, deltaY: 30, zoom: false } },
    );

    expect(state.viewport).toEqual({ scale: 1, offsetX: 0, offsetY: -60 });
  });

  it('clamps zoom to the supported range', () => {
    const state = run(withView({ scale: 1, offsetX: 0, offsetY: 0 }), {
      type: 'zoom',
      factor: 1000,
      anchor: { x: 0, y: 0 },
    });
    expect(state.viewport.scale).toBe(8);
  });
});

describe('text objects', () => {
  it('creates a text object at the click and edits it in place', () => {
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }),
      { type: 'setTool', tool: 'text' },
      press({ x: 30, y: 40 }, idOf('t')),
      { type: 'changeText', id: idOf('t'), text: 'Hello' },
      { type: 'finishText' },
    );

    expect(state.editingTextId).toBeNull();
    expect(state.objects[0]).toMatchObject({ type: 'text', x: 30, y: 40, text: 'Hello' });
  });

  it('removes a text object that is left empty', () => {
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }),
      { type: 'setTool', tool: 'text' },
      press({ x: 30, y: 40 }, idOf('t')),
      { type: 'changeText', id: idOf('t'), text: '   ' },
      { type: 'finishText' },
    );

    expect(state.objects).toEqual([]);
    expect(state.selectedIds).toEqual([]);
  });

  it('reopens an existing text object on double click', () => {
    const text: CanvasObject = {
      id: idOf('t'),
      type: 'text',
      x: 30,
      y: 40,
      text: 'Notes',
      fontSize: 24,
      ...style,
    };
    const state = run(withView({ scale: 1, offsetX: 0, offsetY: 0 }, [text]), {
      type: 'doubleClick',
      screen: { x: 35, y: 45 },
    });

    expect(state.editingTextId).toBe(idOf('t'));
    expect(state.selectedIds).toEqual([idOf('t')]);
  });

  it('caps text length', () => {
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }),
      { type: 'setTool', tool: 'text' },
      press({ x: 0, y: 0 }, idOf('t')),
      { type: 'changeText', id: idOf('t'), text: 'x'.repeat(MAX_TEXT_LENGTH + 10) },
    );

    expect(state.objects[0]).toMatchObject({ text: 'x'.repeat(MAX_TEXT_LENGTH) });
  });

  it('removes an empty text object when another tool is chosen', () => {
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }),
      { type: 'setTool', tool: 'text' },
      press({ x: 0, y: 0 }, idOf('t')),
      { type: 'setTool', tool: 'rectangle' },
    );

    expect(state.editingTextId).toBeNull();
    expect(state.objects).toEqual([]);
  });
});

describe('resizing and grouped transformations', () => {
  it('records a drag as one undo step, and undo and redo move it back and forth', () => {
    const moved = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 100, 100)]),
      press({ x: 0, y: 50 }),
      move({ x: 40, y: 50 }),
      release,
    );
    expect(moved.objects[0]?.x).toBe(40);
    expect(moved.history.past).toHaveLength(1);

    const undone = run(moved, { type: 'undo' });
    expect(undone.objects[0]?.x).toBe(0);
    expect(undone.history.past).toHaveLength(0);

    const redone = run(undone, { type: 'redo' });
    expect(redone.objects[0]?.x).toBe(40);
  });

  it('records nothing for a click that moves nothing', () => {
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 100, 100)]),
      press({ x: 0, y: 50 }),
      release,
    );

    expect(state.history.past).toHaveLength(0);
  });

  it('resizes a selection from its bottom-right handle', () => {
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 100, 100)]),
      ...select({ x: 0, y: 50 }),
      press({ x: 100, y: 100 }),
      move({ x: 150, y: 140 }),
      release,
    );

    expect(state.objects[0]).toMatchObject({ x: 0, y: 0, width: 150, height: 140 });
    expect(state.history.past).toHaveLength(1);
    expect(run(state, { type: 'undo' }).objects[0]).toMatchObject({ width: 100, height: 100 });
  });

  it('resizes from the left edge and keeps the right edge fixed', () => {
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 100, 100)]),
      ...select({ x: 0, y: 50 }),
      press({ x: 0, y: 50 }),
      move({ x: -50, y: 50 }),
      release,
    );

    expect(state.objects[0]).toMatchObject({ x: -50, width: 150 });
  });

  it('clamps a resize to the minimum size instead of inverting the object', () => {
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 100, 100)]),
      ...select({ x: 0, y: 50 }),
      press({ x: 100, y: 50 }),
      move({ x: -100, y: 50 }),
      release,
    );

    expect(state.objects[0]).toMatchObject({ x: 0, width: 1 });
  });

  it('resizes a selection of two objects as one group', () => {
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [
        rectangle('1', 0, 0, 100, 50),
        rectangle('2', 100, 0, 100, 50),
      ]),
      press({ x: -10, y: -10 }),
      move({ x: 210, y: 60 }),
      release,
      press({ x: 200, y: 25 }),
      move({ x: 300, y: 25 }),
      release,
    );

    expect(state.objects[0]).toMatchObject({ x: 0, width: 150, height: 50 });
    expect(state.objects[1]).toMatchObject({ x: 150, width: 150, height: 50 });
  });

  it('moves a selection of two objects together, and one undo restores both', () => {
    const start = withView({ scale: 1, offsetX: 0, offsetY: 0 }, [
      rectangle('1', 0, 0, 100, 50),
      rectangle('2', 100, 0, 100, 50),
    ]);
    const moved = run(
      start,
      press({ x: -10, y: -10 }),
      move({ x: 210, y: 60 }),
      release,
      press({ x: 50, y: 0 }),
      move({ x: 80, y: 0 }),
      release,
    );

    expect(moved.objects.map((object) => object.x)).toEqual([30, 130]);
    expect(run(moved, { type: 'undo' }).objects.map((object) => object.x)).toEqual([0, 100]);
  });

  it('cancelling a drag reverts the preview and records nothing', () => {
    const cancelled = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 100, 100)]),
      press({ x: 0, y: 50 }),
      move({ x: 40, y: 50 }),
      { type: 'pointerCancel' },
    );

    expect(cancelled.objects[0]?.x).toBe(0);
    expect(cancelled.history.past).toHaveLength(0);
  });

  it('undo during a drag cancels the drag first and leaves history alone', () => {
    const committed = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 100, 100)]),
      press({ x: 0, y: 50 }),
      move({ x: 20, y: 50 }),
      release,
      press({ x: 20, y: 50 }),
      move({ x: 60, y: 50 }),
    );

    const afterUndo = run(committed, { type: 'undo' });
    expect(afterUndo.objects[0]?.x).toBe(20);
    expect(afterUndo.history.past).toHaveLength(1);
    expect(afterUndo.gesture).toBeNull();

    expect(run(afterUndo, release, { type: 'undo' }).objects[0]?.x).toBe(0);
  });
});

describe('deletion, copy, paste and duplicate', () => {
  it('deletes the selection, and undo restores it at its original position in the stack', () => {
    const start = withView({ scale: 1, offsetX: 0, offsetY: 0 }, [
      rectangle('1', 0, 0, 50, 50),
      rectangle('2', 100, 0, 50, 50),
      rectangle('3', 200, 0, 50, 50),
    ]);
    const deleted = run(start, ...select({ x: 100, y: 10 }), { type: 'deleteSelected' });

    expect(idsOf(deleted)).toEqual([idOf('1'), idOf('3')]);
    expect(idsOf(run(deleted, { type: 'undo' }))).toEqual([idOf('1'), idOf('2'), idOf('3')]);
  });

  it('copies and pastes with a growing offset, and each paste is its own undo step', () => {
    let counter = 0;
    const makeId = () => uniqueId(++counter);
    const start = withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 50, 50)]);

    const pasted = run(
      start,
      ...select({ x: 0, y: 10 }),
      { type: 'copy' },
      { type: 'paste', makeId },
      { type: 'paste', makeId },
    );

    expect(pasted.objects).toHaveLength(3);
    expect(pasted.objects[1]).toMatchObject({ x: PASTE_OFFSET, y: PASTE_OFFSET });
    expect(pasted.objects[2]).toMatchObject({ x: PASTE_OFFSET * 2, y: PASTE_OFFSET * 2 });
    expect(pasted.selectedIds).toEqual([uniqueId(2)]);
    expect(new Set(pasted.objects.map((object) => object.id)).size).toBe(3);

    const undone = run(pasted, { type: 'undo' });
    expect(undone.objects).toHaveLength(2);
  });

  it('duplicates the selection in place, offset, and leaves the clipboard unchanged', () => {
    let counter = 0;
    const makeId = () => uniqueId(++counter);
    const duplicated = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 50, 50)]),
      ...select({ x: 0, y: 10 }),
      { type: 'duplicate', makeId },
    );

    expect(duplicated.objects[1]).toMatchObject({ x: PASTE_OFFSET, y: PASTE_OFFSET });
    expect(duplicated.selectedIds).toEqual([uniqueId(1)]);
    expect(duplicated.clipboard).toBeNull();
  });

  it('cut removes the selection and keeps it on the clipboard for pasting', () => {
    let counter = 0;
    const makeId = () => uniqueId(++counter);
    const cut = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 50, 50)]),
      ...select({ x: 0, y: 10 }),
      { type: 'cut' },
    );

    expect(cut.objects).toHaveLength(0);
    const pasted = run(cut, { type: 'paste', makeId });
    expect(pasted.objects).toHaveLength(1);
    expect(pasted.objects[0]).toMatchObject({ x: PASTE_OFFSET, y: PASTE_OFFSET });
  });

  it('pastes nothing when the clipboard is empty', () => {
    const state = withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 50, 50)]);
    expect(run(state, { type: 'paste', makeId: () => uniqueId(1) })).toEqual(state);
  });
});

describe('layer ordering', () => {
  const row = () =>
    withView({ scale: 1, offsetX: 0, offsetY: 0 }, [
      rectangle('a', 0, 0, 50, 50),
      rectangle('b', 100, 0, 50, 50),
      rectangle('c', 200, 0, 50, 50),
    ]);

  it('moves the selection to the front and back', () => {
    const front = run(row(), ...select({ x: 0, y: 10 }), {
      type: 'reorder',
      direction: 'front',
    });
    expect(idsOf(front)).toEqual([idOf('b'), idOf('c'), idOf('a')]);

    const back = run(front, { type: 'reorder', direction: 'back' });
    expect(idsOf(back)).toEqual([idOf('a'), idOf('b'), idOf('c')]);
  });

  it('steps the selection forward and backward past its neighbours', () => {
    const forward = run(row(), ...select({ x: 0, y: 10 }), {
      type: 'reorder',
      direction: 'forward',
    });
    expect(idsOf(forward)).toEqual([idOf('b'), idOf('a'), idOf('c')]);

    const backward = run(forward, ...select({ x: 200, y: 10 }), {
      type: 'reorder',
      direction: 'backward',
    });
    expect(idsOf(backward)).toEqual([idOf('b'), idOf('c'), idOf('a')]);
  });

  it('keeps a selected run together when moving forward', () => {
    const forward = run(
      row(),
      press({ x: 0, y: 10 }, idOf('s')),
      release,
      press({ x: 100, y: 10 }, idOf('s'), true),
      release,
      { type: 'reorder', direction: 'forward' },
    );

    expect(idsOf(forward)).toEqual([idOf('c'), idOf('a'), idOf('b')]);
  });

  it('records layer changes as undoable steps', () => {
    const front = run(row(), ...select({ x: 0, y: 10 }), {
      type: 'reorder',
      direction: 'front',
    });
    expect(idsOf(run(front, { type: 'undo' }))).toEqual([idOf('a'), idOf('b'), idOf('c')]);
  });
});

describe('nudging and selecting everything', () => {
  it('nudges the selection in world units and undoes each nudge', () => {
    const state = run(
      withView({ scale: 2, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 50, 50)]),
      ...select({ x: 0, y: 20 }),
      { type: 'nudge', dx: 1, dy: 0 },
      { type: 'nudge', dx: 10, dy: 0 },
    );

    expect(state.objects[0]).toMatchObject({ x: 11, y: 0 });
    expect(run(state, { type: 'undo' }).objects[0]).toMatchObject({ x: 1 });
  });

  it('selects every object with select all', () => {
    const state = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [
        rectangle('1', 0, 0, 50, 50),
        rectangle('2', 100, 0, 50, 50),
      ]),
      { type: 'selectAll' },
    );

    expect(state.selectedIds).toEqual([idOf('1'), idOf('2')]);
  });
});

describe('text and freehand alongside transformations', () => {
  it('keeps a text session and a later move as separate undo steps', () => {
    const text = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }),
      { type: 'setTool', tool: 'text' },
      press({ x: 0, y: 0 }, idOf('t')),
      { type: 'changeText', id: idOf('t'), text: 'Hi' },
      { type: 'finishText' },
    );
    expect(text.history.past).toHaveLength(1);

    const moved = run(
      text,
      { type: 'setTool', tool: 'select' },
      press({ x: 5, y: 5 }),
      move({ x: 25, y: 5 }),
      release,
    );
    expect(moved.objects[0]).toMatchObject({ x: 20, y: 0, text: 'Hi' });
    expect(moved.history.past).toHaveLength(2);

    const undoneMove = run(moved, { type: 'undo' });
    expect(undoneMove.objects[0]).toMatchObject({ x: 0, text: 'Hi' });

    const undoneText = run(undoneMove, { type: 'undo' });
    expect(undoneText.objects).toEqual([]);
    expect(run(undoneText, { type: 'redo' }, { type: 'redo' }).objects[0]).toMatchObject({
      x: 20,
      text: 'Hi',
    });
  });

  it('records an edit to existing text as one step, including undo of the text change', () => {
    const existing: CanvasObject = {
      id: idOf('t'),
      type: 'text',
      x: 30,
      y: 40,
      text: 'Notes',
      fontSize: 24,
      ...style,
    };
    const edited = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [existing]),
      { type: 'doubleClick', screen: { x: 35, y: 45 } },
      { type: 'changeText', id: idOf('t'), text: 'Notes 2' },
      { type: 'changeText', id: idOf('t'), text: 'Notes 22' },
      { type: 'finishText' },
    );

    expect(edited.history.past).toHaveLength(1);
    expect(run(edited, { type: 'undo' }).objects[0]).toMatchObject({ text: 'Notes' });
  });

  it('keeps a freehand stroke separate from earlier transformations', () => {
    const drawn = run(
      withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 100, 100)]),
      ...select({ x: 0, y: 50 }),
      press({ x: 0, y: 25 }),
      move({ x: 30, y: 25 }),
      release,
      { type: 'setTool', tool: 'pen' },
      press({ x: 300, y: 300 }, idOf('p')),
      move({ x: 320, y: 320 }),
      move({ x: 340, y: 340 }),
      release,
    );

    expect(drawn.objects).toHaveLength(2);
    expect(drawn.objects[1]).toMatchObject({ type: 'pen' });
    expect(drawn.history.past).toHaveLength(2);

    const withoutPen = run(drawn, { type: 'undo' });
    expect(withoutPen.objects).toHaveLength(1);
    expect(withoutPen.objects[0]).toMatchObject({ x: 30 });
  });
});

describe('history limits', () => {
  it('keeps at most MAX_HISTORY steps', () => {
    const start = withView({ scale: 1, offsetX: 0, offsetY: 0 }, [rectangle('1', 0, 0, 50, 50)]);
    let state = run(start, { type: 'selectAll' });
    for (let step = 0; step < MAX_HISTORY + 5; step += 1) {
      state = run(state, { type: 'nudge', dx: 1, dy: 0 });
    }

    expect(state.history.past).toHaveLength(MAX_HISTORY);
    expect(state.objects[0]?.x).toBe(MAX_HISTORY + 5);
  });
});
