import { describe, expect, it } from 'vitest';
import type { Point } from '@inkroom/shared';
import { consistencyProblems } from './doc/model';
import type { EditorAction } from './editor';
import { EditorSession } from './session';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

// The view and the document must agree after every step. This is the invariant the session exists
// to keep, so every test checks it.
function expectConsistent(session: EditorSession): void {
  expect(session.document.snapshot()).toEqual(session.getState().objects);
  expect(consistencyProblems(session.document.objects)).toEqual([]);
}

function act(session: EditorSession, ...actions: EditorAction[]): void {
  for (const action of actions) {
    session.dispatch(action);
  }
}

function drawRectangle(session: EditorSession, from: Point, to: Point, n: number): void {
  act(
    session,
    { type: 'setTool', tool: 'rectangle' },
    { type: 'pointerDown', screen: from, button: 0, shift: false, id: uuid(n) },
    { type: 'pointerMove', screen: to },
    { type: 'pointerUp' },
  );
}

// Connects two sessions so that each one's local document updates reach the other.
function connect(a: EditorSession, b: EditorSession): void {
  a.document.onLocalUpdate((update) => b.document.applyRemote(update));
  b.document.onLocalUpdate((update) => a.document.applyRemote(update));
}

describe('editor session and document', () => {
  it('writes a drawn rectangle to the document and keeps the two equal', () => {
    const session = new EditorSession();

    drawRectangle(session, { x: 0, y: 0 }, { x: 100, y: 60 }, 1);

    expectConsistent(session);
    expect(session.document.snapshot()).toHaveLength(1);
    expect(session.getState().undoState.canUndo).toBe(true);
  });

  it('keeps undo and redo in step between the view and the document', () => {
    const session = new EditorSession();
    drawRectangle(session, { x: 0, y: 0 }, { x: 100, y: 60 }, 1);

    act(session, { type: 'undo' });
    expectConsistent(session);
    expect(session.getState().objects).toEqual([]);
    expect(session.getState().undoState.canRedo).toBe(true);

    act(session, { type: 'redo' });
    expectConsistent(session);
    expect(session.getState().objects).toHaveLength(1);
    expect(session.getState().undoState.canRedo).toBe(false);
  });

  it('makes a whole drag one undo step, and undo returns the object to its start', () => {
    const session = new EditorSession();
    drawRectangle(session, { x: 0, y: 0 }, { x: 100, y: 60 }, 1);
    act(
      session,
      { type: 'setTool', tool: 'select' },
      { type: 'pointerDown', screen: { x: 0, y: 15 }, button: 0, shift: false, id: uuid(9) },
      { type: 'pointerMove', screen: { x: 20, y: 15 } },
      { type: 'pointerMove', screen: { x: 40, y: 15 } },
      { type: 'pointerUp' },
    );
    expectConsistent(session);
    expect(session.getState().objects[0]).toMatchObject({ x: 40 });

    act(session, { type: 'undo' });
    expectConsistent(session);
    expect(session.getState().objects[0]).toMatchObject({ x: 0 });

    act(session, { type: 'undo' });
    expectConsistent(session);
    expect(session.getState().objects).toEqual([]);
  });

  it('makes one text session one undo step', () => {
    const session = new EditorSession();
    act(
      session,
      { type: 'setTool', tool: 'text' },
      { type: 'pointerDown', screen: { x: 30, y: 40 }, button: 0, shift: false, id: uuid(2) },
      { type: 'changeText', id: uuid(2), text: 'H' },
      { type: 'changeText', id: uuid(2), text: 'Hi' },
      { type: 'finishText' },
    );
    expectConsistent(session);
    expect(session.document.snapshot()[0]).toMatchObject({ text: 'Hi' });

    act(session, { type: 'undo' });

    expectConsistent(session);
    expect(session.getState().objects).toEqual([]);
  });

  it('undoes an edit to existing text on its own, leaving the text before it', () => {
    const session = new EditorSession();
    act(
      session,
      { type: 'setTool', tool: 'text' },
      { type: 'pointerDown', screen: { x: 30, y: 40 }, button: 0, shift: false, id: uuid(2) },
      { type: 'changeText', id: uuid(2), text: 'Notes' },
      { type: 'finishText' },
      { type: 'setTool', tool: 'select' },
      { type: 'doubleClick', screen: { x: 35, y: 45 } },
      { type: 'changeText', id: uuid(2), text: 'Notes 2' },
      { type: 'finishText' },
    );
    expect(session.document.snapshot()[0]).toMatchObject({ text: 'Notes 2' });

    act(session, { type: 'undo' });

    expectConsistent(session);
    expect(session.getState().objects[0]).toMatchObject({ text: 'Notes' });
  });

  it('cancels an in-progress drag on undo before undoing anything else', () => {
    const session = new EditorSession();
    drawRectangle(session, { x: 0, y: 0 }, { x: 100, y: 60 }, 1);
    act(
      session,
      { type: 'setTool', tool: 'select' },
      { type: 'pointerDown', screen: { x: 0, y: 15 }, button: 0, shift: false, id: uuid(9) },
      { type: 'pointerMove', screen: { x: 20, y: 15 } },
    );

    act(session, { type: 'undo' });

    expectConsistent(session);
    expect(session.getState().gesture).toBeNull();
    expect(session.getState().objects).toHaveLength(1);
    expect(session.getState().objects[0]).toMatchObject({ x: 0 });
  });

  it('keeps a layer change consistent and undoable', () => {
    const session = new EditorSession();
    drawRectangle(session, { x: 0, y: 0 }, { x: 100, y: 60 }, 1);
    drawRectangle(session, { x: 200, y: 0 }, { x: 300, y: 60 }, 2);
    act(
      session,
      { type: 'setTool', tool: 'select' },
      { type: 'pointerDown', screen: { x: 0, y: 15 }, button: 0, shift: false, id: uuid(9) },
      { type: 'pointerUp' },
      { type: 'reorder', direction: 'front' },
    );
    expectConsistent(session);
    expect(session.getState().objects.map((object) => object.id)).toEqual([uuid(2), uuid(1)]);

    act(session, { type: 'undo' });

    expectConsistent(session);
    expect(session.getState().objects.map((object) => object.id)).toEqual([uuid(1), uuid(2)]);
  });

  it('keeps delete, select all and paste consistent with the document', () => {
    const session = new EditorSession();
    drawRectangle(session, { x: 0, y: 0 }, { x: 100, y: 60 }, 1);
    drawRectangle(session, { x: 200, y: 0 }, { x: 300, y: 60 }, 2);

    act(session, { type: 'selectAll' }, { type: 'deleteSelected' });
    expectConsistent(session);
    expect(session.getState().objects).toEqual([]);

    act(session, { type: 'undo' });
    expectConsistent(session);
    expect(session.getState().objects).toHaveLength(2);

    let next = 100;
    const makeId = () => uuid((next += 1));
    act(session, { type: 'selectAll' }, { type: 'copy' }, { type: 'paste', makeId });
    expectConsistent(session);
    expect(session.getState().objects).toHaveLength(4);
  });
});

describe('two connected sessions', () => {
  it('shows remote changes in the view, and local undo leaves them in place', () => {
    const a = new EditorSession();
    const b = new EditorSession();
    connect(a, b);

    drawRectangle(a, { x: 0, y: 0 }, { x: 100, y: 60 }, 1);
    expect(b.getState().objects.map((object) => object.id)).toEqual([uuid(1)]);

    drawRectangle(b, { x: 200, y: 0 }, { x: 300, y: 60 }, 2);
    expect(a.getState().objects.map((object) => object.id)).toEqual([uuid(1), uuid(2)]);

    act(a, { type: 'undo' });

    expect(a.getState().objects.map((object) => object.id)).toEqual([uuid(2)]);
    expect(b.getState().objects.map((object) => object.id)).toEqual([uuid(2)]);
    expectConsistent(a);
    expectConsistent(b);
  });

  it('ends an in-progress drag when the document changes underneath it', () => {
    const a = new EditorSession();
    const b = new EditorSession();
    connect(a, b);
    drawRectangle(a, { x: 0, y: 0 }, { x: 100, y: 60 }, 1);
    act(
      a,
      { type: 'setTool', tool: 'select' },
      { type: 'pointerDown', screen: { x: 0, y: 15 }, button: 0, shift: false, id: uuid(9) },
      { type: 'pointerMove', screen: { x: 20, y: 15 } },
    );

    drawRectangle(b, { x: 300, y: 300 }, { x: 360, y: 340 }, 2);

    expect(a.getState().gesture).toBeNull();
    expectConsistent(a);
    expectConsistent(b);
    expect(a.getState().objects).toHaveLength(2);
  });
});
