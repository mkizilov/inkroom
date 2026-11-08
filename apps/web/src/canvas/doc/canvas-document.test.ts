import { describe, expect, it } from 'vitest';
import { OperationError, diffDocuments, type CanvasObject } from '@inkroom/shared';
import { consistencyProblems } from '@inkroom/shared';
import { CanvasDocument, LOCAL_ORIGIN, REMOTE_ORIGIN } from './canvas-document';

const style = { stroke: '#1f2328', strokeWidth: 2 };
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const rect = (n: number, x = 0): CanvasObject => ({
  id: uuid(n),
  type: 'rectangle',
  x,
  y: 0,
  width: 10,
  height: 20,
  ...style,
});
const text = (n: number, value: string): CanvasObject => ({
  id: uuid(n),
  type: 'text',
  x: 0,
  y: 0,
  text: value,
  fontSize: 24,
  ...style,
});

const idsOf = (objects: CanvasObject[]) => objects.map((object) => object.id);

// Two replicas that send every local update to the other as soon as it is made.
function connect(a: CanvasDocument, b: CanvasDocument): void {
  a.onLocalUpdate((update) => b.applyRemote(update));
  b.onLocalUpdate((update) => a.applyRemote(update));
}

describe('local undo and redo', () => {
  it('undoes and redoes a local write', () => {
    const doc = new CanvasDocument();
    doc.apply([{ type: 'insert', index: 0, objects: [rect(1)] }], { boundary: true });
    expect(doc.snapshot()).toEqual([rect(1)]);
    expect(doc.canUndo()).toBe(true);

    expect(doc.undo()).toBe(true);
    expect(doc.snapshot()).toEqual([]);
    expect(doc.canRedo()).toBe(true);

    doc.redo();
    expect(doc.snapshot()).toEqual([rect(1)]);
  });

  it('reports nothing to undo on a new document', () => {
    const doc = new CanvasDocument();
    expect(doc.canUndo()).toBe(false);
    expect(doc.canRedo()).toBe(false);
    expect(doc.undo()).toBe(false);
  });

  it('writes that do not start a step join the step that is open', () => {
    const doc = new CanvasDocument();
    doc.apply([{ type: 'insert', index: 0, objects: [rect(1)] }], { boundary: true });
    doc.apply([{ type: 'update', id: uuid(1), changes: { x: 5 } }], { boundary: false });
    doc.apply([{ type: 'update', id: uuid(1), changes: { x: 9 } }], { boundary: false });

    doc.undo();

    expect(doc.snapshot()).toEqual([]);
  });

  it('a boundary starts a new step', () => {
    const doc = new CanvasDocument();
    doc.apply([{ type: 'insert', index: 0, objects: [rect(1)] }], { boundary: true });
    doc.apply([{ type: 'insert', index: 1, objects: [rect(2)] }], { boundary: true });

    doc.undo();

    expect(idsOf(doc.snapshot())).toEqual([uuid(1)]);
  });

  it('a write after an undo starts a new step even without a boundary', () => {
    const doc = new CanvasDocument();
    doc.apply([{ type: 'insert', index: 0, objects: [rect(1)] }], { boundary: true });
    doc.apply([{ type: 'insert', index: 1, objects: [rect(2)] }], { boundary: true });
    doc.undo();
    doc.apply([{ type: 'insert', index: 1, objects: [rect(3)] }], { boundary: false });

    doc.undo();

    expect(idsOf(doc.snapshot())).toEqual([uuid(1)]);
  });

  it('a new write discards the redo steps', () => {
    const doc = new CanvasDocument();
    doc.apply([{ type: 'insert', index: 0, objects: [rect(1)] }], { boundary: true });
    doc.undo();
    doc.apply([{ type: 'insert', index: 0, objects: [rect(2)] }], { boundary: true });

    expect(doc.canRedo()).toBe(false);
  });

  it('applies nothing when a batch does not fit the document', () => {
    const doc = new CanvasDocument();
    doc.apply([{ type: 'insert', index: 0, objects: [rect(1)] }], { boundary: true });

    expect(() =>
      doc.apply([{ type: 'update', id: uuid(9), changes: { x: 1 } }], { boundary: true }),
    ).toThrow(OperationError);
    expect(doc.snapshot()).toEqual([rect(1)]);
    expect(consistencyProblems(doc.objects)).toEqual([]);
  });

  it('notifies subscribers of writes with the local origin and of undo with another', () => {
    const doc = new CanvasDocument();
    const origins: unknown[] = [];
    doc.subscribe((change) => origins.push(change.origin));

    doc.apply([{ type: 'insert', index: 0, objects: [rect(1)] }], { boundary: true });
    doc.undo();

    expect(origins[0]).toBe(LOCAL_ORIGIN);
    expect(origins[1]).not.toBe(LOCAL_ORIGIN);
  });
});

describe('remote updates', () => {
  it('are visible on the other replica but never become local undo steps', () => {
    const a = new CanvasDocument();
    const b = new CanvasDocument();
    connect(a, b);

    a.apply([{ type: 'insert', index: 0, objects: [rect(1)] }], { boundary: true });
    b.apply([{ type: 'insert', index: 0, objects: [rect(2)] }], { boundary: true });

    expect(idsOf(a.snapshot()).sort()).toEqual([uuid(1), uuid(2)]);

    a.undo();

    expect(idsOf(a.snapshot())).toEqual([uuid(2)]);
    expect(idsOf(b.snapshot())).toEqual([uuid(2)]);
  });

  it('do not make a replica undoable on their own', () => {
    const a = new CanvasDocument();
    const b = new CanvasDocument();
    connect(a, b);

    b.apply([{ type: 'insert', index: 0, objects: [rect(1)] }], { boundary: true });

    expect(a.canUndo()).toBe(false);
    expect(idsOf(a.snapshot())).toEqual([uuid(1)]);
  });

  it('are reported to subscribers with the remote origin', () => {
    const a = new CanvasDocument();
    const b = new CanvasDocument();
    const origins: unknown[] = [];
    a.subscribe((change) => origins.push(change.origin));
    connect(b, a);

    b.apply([{ type: 'insert', index: 0, objects: [rect(1)] }], { boundary: true });

    expect(origins).toEqual([REMOTE_ORIGIN]);
  });
});

// Deterministic pseudo-random numbers, so every run replays the same edits.
function generator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Applies a seeded sequence of edits to a document, with a mix of inserts, removals, moves, text
// edits and reorders. Each edit is written through the document as a diff, the way the editor does.
function scenario(doc: CanvasDocument, seed: number, steps: number): void {
  const random = generator(seed);
  let nextNumber = 1;
  for (let step = 0; step < steps; step += 1) {
    const current = doc.snapshot();
    const index = Math.floor(random() * (current.length + 1));
    const choice = random();
    let next: CanvasObject[];
    if (current.length === 0 || choice < 0.35) {
      const created = random() < 0.5 ? rect(nextNumber, index) : text(nextNumber, `note ${step}`);
      nextNumber += 1;
      next = [...current.slice(0, index), created, ...current.slice(index)];
    } else if (choice < 0.5) {
      next = current.filter((_, position) => position !== Math.min(index, current.length - 1));
    } else if (choice < 0.85) {
      const target = Math.min(index, current.length - 1);
      next = current.map((object, position) => {
        if (position !== target) {
          return object;
        }
        return object.type === 'text'
          ? { ...object, text: `${object.text}!` }
          : { ...object, x: object.x + 3 };
      });
    } else {
      next = [...current].reverse();
    }
    doc.apply(diffDocuments(current, next), { boundary: random() < 0.5 });
  }
}

describe('convergence', () => {
  it('replicas reach the same state whatever order the updates arrive in', () => {
    for (const seed of [3, 11, 2026]) {
      const source = new CanvasDocument();
      const updates: Uint8Array[] = [];
      source.onLocalUpdate((update) => updates.push(update));
      scenario(source, seed, 40);
      const expected = source.snapshot();

      const forward = new CanvasDocument();
      for (const update of updates) {
        forward.applyRemote(update);
      }

      const reversed = new CanvasDocument();
      for (const update of [...updates].reverse()) {
        reversed.applyRemote(update);
      }

      const shuffled = new CanvasDocument();
      const random = generator(seed + 1);
      const order = updates
        .map((update) => ({ update, key: random() }))
        .sort((x, y) => x.key - y.key)
        .map((entry) => entry.update);
      for (const update of order) {
        shuffled.applyRemote(update);
      }

      for (const replica of [forward, reversed, shuffled]) {
        expect(replica.snapshot()).toEqual(expected);
        expect(replica.invalidIds()).toEqual([]);
      }
      expect(expected.length).toBeGreaterThan(0);
    }
  });

  it('concurrent edits to different fields of one object both survive', () => {
    const a = new CanvasDocument();
    const b = new CanvasDocument();
    a.apply([{ type: 'insert', index: 0, objects: [rect(1)] }], { boundary: true });
    b.applyRemote(a.encodeState());

    const aUpdates: Uint8Array[] = [];
    const bUpdates: Uint8Array[] = [];
    a.onLocalUpdate((update) => aUpdates.push(update));
    b.onLocalUpdate((update) => bUpdates.push(update));
    a.apply([{ type: 'update', id: uuid(1), changes: { x: 40 } }], { boundary: true });
    b.apply([{ type: 'update', id: uuid(1), changes: { height: 90 } }], { boundary: true });

    for (const update of bUpdates) a.applyRemote(update);
    for (const update of aUpdates) b.applyRemote(update);

    expect(a.snapshot()).toEqual(b.snapshot());
    expect(a.snapshot()[0]).toMatchObject({ x: 40, height: 90 });
  });

  it('concurrent text edits at different places in the text merge', () => {
    const a = new CanvasDocument();
    const b = new CanvasDocument();
    a.apply([{ type: 'insert', index: 0, objects: [text(1, 'one two')] }], { boundary: true });
    b.applyRemote(a.encodeState());

    const aUpdates: Uint8Array[] = [];
    const bUpdates: Uint8Array[] = [];
    a.onLocalUpdate((update) => aUpdates.push(update));
    b.onLocalUpdate((update) => bUpdates.push(update));
    a.apply([{ type: 'update', id: uuid(1), changes: { text: 'ONE two' } }], { boundary: true });
    b.apply([{ type: 'update', id: uuid(1), changes: { text: 'one TWO' } }], { boundary: true });

    for (const update of bUpdates) a.applyRemote(update);
    for (const update of aUpdates) b.applyRemote(update);

    expect(a.snapshot()[0]).toMatchObject({ text: 'ONE TWO' });
    expect(b.snapshot()).toEqual(a.snapshot());
  });

  it('a deletion and an edit of the same object converge to deleted', () => {
    const a = new CanvasDocument();
    const b = new CanvasDocument();
    a.apply([{ type: 'insert', index: 0, objects: [text(1, 'draft')] }], { boundary: true });
    b.applyRemote(a.encodeState());

    const aUpdates: Uint8Array[] = [];
    const bUpdates: Uint8Array[] = [];
    a.onLocalUpdate((update) => aUpdates.push(update));
    b.onLocalUpdate((update) => bUpdates.push(update));
    a.apply([{ type: 'remove', ids: [uuid(1)] }], { boundary: true });
    b.apply([{ type: 'update', id: uuid(1), changes: { text: 'edited' } }], { boundary: true });

    for (const update of bUpdates) a.applyRemote(update);
    for (const update of aUpdates) b.applyRemote(update);

    expect(a.snapshot()).toEqual([]);
    expect(b.snapshot()).toEqual([]);
  });

  it('concurrent reorders converge to one order on every replica', () => {
    const a = new CanvasDocument();
    const b = new CanvasDocument();
    a.apply(
      [{ type: 'insert', index: 0, objects: [rect(1), rect(2), rect(3)] }],
      { boundary: true },
    );
    b.applyRemote(a.encodeState());

    const aUpdates: Uint8Array[] = [];
    const bUpdates: Uint8Array[] = [];
    a.onLocalUpdate((update) => aUpdates.push(update));
    b.onLocalUpdate((update) => bUpdates.push(update));
    a.apply([{ type: 'reorder', ids: [uuid(3), uuid(2), uuid(1)] }], { boundary: true });
    b.apply([{ type: 'reorder', ids: [uuid(2), uuid(1), uuid(3)] }], { boundary: true });

    for (const update of bUpdates) a.applyRemote(update);
    for (const update of aUpdates) b.applyRemote(update);

    expect(a.snapshot()).toEqual(b.snapshot());
    expect(new Set(idsOf(a.snapshot())).size).toBe(3);
  });

  it('inserts made concurrently at the same position both survive', () => {
    const a = new CanvasDocument();
    const b = new CanvasDocument();
    a.apply([{ type: 'insert', index: 0, objects: [rect(1)] }], { boundary: true });
    b.applyRemote(a.encodeState());

    const aUpdates: Uint8Array[] = [];
    const bUpdates: Uint8Array[] = [];
    a.onLocalUpdate((update) => aUpdates.push(update));
    b.onLocalUpdate((update) => bUpdates.push(update));
    a.apply([{ type: 'insert', index: 0, objects: [rect(2)] }], { boundary: true });
    b.apply([{ type: 'insert', index: 0, objects: [rect(3)] }], { boundary: true });

    for (const update of bUpdates) a.applyRemote(update);
    for (const update of aUpdates) b.applyRemote(update);

    expect(a.snapshot()).toEqual(b.snapshot());
    expect(new Set(idsOf(a.snapshot()))).toEqual(new Set([uuid(1), uuid(2), uuid(3)]));
  });
});
