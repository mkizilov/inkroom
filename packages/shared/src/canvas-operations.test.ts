import { describe, expect, it } from 'vitest';
import type { CanvasObject } from './canvas';
import {
  OperationError,
  applyOperations,
  canvasOperationSchema,
  diffDocuments,
  type CanvasOperation,
} from './canvas-operations';

const style = { stroke: '#1f2328', strokeWidth: 2 };
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const rect = (n: number, x = 0, y = 0): CanvasObject => ({
  id: uuid(n),
  type: 'rectangle',
  x,
  y,
  width: 10,
  height: 10,
  ...style,
});
const text = (n: number, value = 'Hi'): CanvasObject => ({
  id: uuid(n),
  type: 'text',
  x: 0,
  y: 0,
  text: value,
  fontSize: 24,
  ...style,
});

describe('applyOperations', () => {
  it('inserts objects at an index', () => {
    const result = applyOperations(
      [rect(1), rect(2)],
      [{ type: 'insert', index: 1, objects: [rect(3)] }],
    );
    expect(result.map((object) => object.id)).toEqual([uuid(1), uuid(3), uuid(2)]);
  });

  it('removes objects by id', () => {
    const result = applyOperations(
      [rect(1), rect(2), rect(3)],
      [{ type: 'remove', ids: [uuid(1), uuid(3)] }],
    );
    expect(result.map((object) => object.id)).toEqual([uuid(2)]);
  });

  it('updates only the named fields of an object', () => {
    const [updated] = applyOperations(
      [rect(1)],
      [{ type: 'update', id: uuid(1), changes: { x: 50, width: 80 } }],
    );
    expect(updated).toEqual({ ...rect(1), x: 50, width: 80 });
  });

  it('reorders by a full permutation of ids', () => {
    const result = applyOperations(
      [rect(1), rect(2), rect(3)],
      [{ type: 'reorder', ids: [uuid(3), uuid(1), uuid(2)] }],
    );
    expect(result.map((object) => object.id)).toEqual([uuid(3), uuid(1), uuid(2)]);
  });

  it('does not modify the input array or its objects', () => {
    const input = [rect(1)];
    applyOperations(input, [{ type: 'update', id: uuid(1), changes: { x: 9 } }]);
    expect(input[0]?.x).toBe(0);
  });

  it('rejects inserting an id that already exists', () => {
    expect(() =>
      applyOperations([rect(1)], [{ type: 'insert', index: 0, objects: [rect(1)] }]),
    ).toThrow(OperationError);
  });

  it('rejects an insert index past the end', () => {
    expect(() =>
      applyOperations([rect(1)], [{ type: 'insert', index: 5, objects: [rect(2)] }]),
    ).toThrow(/beyond the end/);
  });

  it('rejects removing or updating an unknown id', () => {
    expect(() => applyOperations([rect(1)], [{ type: 'remove', ids: [uuid(9)] }])).toThrow(
      /does not exist/,
    );
    expect(() =>
      applyOperations([rect(1)], [{ type: 'update', id: uuid(9), changes: { x: 1 } }]),
    ).toThrow(/does not exist/);
  });

  it('rejects an update that produces an invalid object', () => {
    expect(() =>
      applyOperations([rect(1)], [{ type: 'update', id: uuid(1), changes: { width: -1 } }]),
    ).toThrow(/invalid/);
  });

  it('rejects a field that does not apply to the object type', () => {
    expect(() =>
      applyOperations(
        [rect(1)],
        [
          {
            type: 'update',
            id: uuid(1),
            changes: {
              points: [
                { x: 0, y: 0 },
                { x: 1, y: 1 },
              ],
            },
          },
        ],
      ),
    ).toThrow(/does not apply to rectangle/);
  });

  it('rejects a reorder that is not a permutation', () => {
    expect(() =>
      applyOperations([rect(1), rect(2)], [{ type: 'reorder', ids: [uuid(1), uuid(1)] }]),
    ).toThrow(/exactly once/);
    expect(() =>
      applyOperations([rect(1), rect(2)], [{ type: 'reorder', ids: [uuid(1)] }]),
    ).toThrow(/exactly once/);
  });
});

describe('operation schema', () => {
  it('accepts each operation type', () => {
    const operations: CanvasOperation[] = [
      { type: 'insert', index: 0, objects: [rect(1)] },
      { type: 'remove', ids: [uuid(1)] },
      { type: 'update', id: uuid(1), changes: { x: 1 } },
      { type: 'reorder', ids: [uuid(1)] },
    ];
    for (const operation of operations) {
      expect(canvasOperationSchema.safeParse(operation).success).toBe(true);
    }
  });

  it('rejects unknown operation types and unknown change fields', () => {
    expect(canvasOperationSchema.safeParse({ type: 'move', id: uuid(1) }).success).toBe(false);
    expect(
      canvasOperationSchema.safeParse({ type: 'update', id: uuid(1), changes: { colour: '#000' } })
        .success,
    ).toBe(false);
  });
});

describe('diffDocuments', () => {
  it('produces no operations for identical documents', () => {
    expect(diffDocuments([rect(1)], [rect(1)])).toEqual([]);
  });

  it('describes a field change as an update of only that field', () => {
    expect(diffDocuments([rect(1)], [rect(1, 5, 0)])).toEqual([
      { type: 'update', id: uuid(1), changes: { x: 5 } },
    ]);
  });

  it('describes additions and removals by id', () => {
    const before = [rect(1), rect(2)];
    const after = [rect(1), rect(3)];
    const operations = diffDocuments(before, after);

    expect(operations).toEqual([
      { type: 'remove', ids: [uuid(2)] },
      { type: 'insert', index: 1, objects: [rect(3)] },
    ]);
  });

  it('describes a change of z-order as a reorder', () => {
    const operations = diffDocuments([rect(1), rect(2)], [rect(2), rect(1)]);
    expect(operations).toEqual([{ type: 'reorder', ids: [uuid(2), uuid(1)] }]);
  });

  it('replaces an object whose type changes, even when its id is kept', () => {
    const replacement = text(1, 'x');
    expect(diffDocuments([rect(1)], [replacement])).toEqual([
      { type: 'remove', ids: [uuid(1)] },
      { type: 'insert', index: 0, objects: [replacement] },
    ]);
  });

  it('round-trips forward and back for documents built from edits', () => {
    const before = [rect(1), text(2), rect(3)];
    const after = [text(2, 'Changed'), rect(4, 3, 3), rect(1, 7, 7)];

    const forward = diffDocuments(before, after);
    expect(applyOperations(before, forward)).toEqual(after);

    const inverse = diffDocuments(after, before);
    expect(applyOperations(after, inverse)).toEqual(before);
  });
});

// Deterministic pseudo-random edit sequences check the round trip across many shapes of change.
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

describe('diffDocuments over random edit sequences', () => {
  for (const seed of [1, 7, 42, 2026]) {
    it(`reproduces every intermediate document for seed ${seed}`, () => {
      const random = generator(seed);
      let nextNumber = 1;
      let document: CanvasObject[] = [];

      for (let step = 0; step < 60; step += 1) {
        const next = mutate(document, random, () => nextNumber++);

        const forward = diffDocuments(document, next);
        expect(applyOperations(document, forward)).toEqual(next);
        expect(applyOperations(next, diffDocuments(next, document))).toEqual(document);
        for (const operation of forward) {
          expect(canvasOperationSchema.safeParse(operation).success).toBe(true);
        }

        document = next;
      }
    });
  }
});

function mutate(
  objects: CanvasObject[],
  random: () => number,
  nextNumber: () => number,
): CanvasObject[] {
  const choice = random();
  const index = Math.floor(random() * (objects.length + 1));

  if (choice < 0.3 || objects.length === 0) {
    const created = randomObject(nextNumber(), random);
    return [...objects.slice(0, index), created, ...objects.slice(index)];
  }
  if (choice < 0.45) {
    const victim = Math.min(objects.length - 1, index);
    return objects.filter((_, position) => position !== victim);
  }
  if (choice < 0.8) {
    const target = Math.min(objects.length - 1, index);
    return objects.map((object, position) => {
      if (position !== target) {
        return object;
      }
      if (object.type === 'text') {
        return { ...object, text: `${object.text}!` };
      }
      return { ...object, x: object.x + Math.floor(random() * 20) };
    });
  }
  return [...objects].reverse();
}

function randomObject(number: number, random: () => number): CanvasObject {
  const base = { id: uuid(number), x: Math.floor(random() * 100), y: 0, ...style };
  const kind = Math.floor(random() * 3);
  if (kind === 0) {
    return { ...base, type: 'rectangle', width: 10 + Math.floor(random() * 50), height: 20 };
  }
  if (kind === 1) {
    return { ...base, type: 'text', text: 'note', fontSize: 16 };
  }
  return {
    ...base,
    type: 'pen',
    points: [
      { x: 0, y: 0 },
      { x: 5, y: 9 },
    ],
  };
}
