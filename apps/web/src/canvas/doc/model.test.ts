import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { OperationError, type CanvasObject, type CanvasOperation } from '@inkroom/shared';
import {
  consistencyProblems,
  objectsMapOf,
  readOrderedObjects,
  writeOperations,
  type ObjectMap,
} from './model';

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
const text = (n: number, value = 'Hi'): CanvasObject => ({
  id: uuid(n),
  type: 'text',
  x: 5,
  y: 6,
  text: value,
  fontSize: 24,
  ...style,
});

function fresh() {
  const doc = new Y.Doc();
  return { doc, objects: objectsMapOf(doc) };
}

function write(doc: Y.Doc, objects: ReturnType<typeof objectsMapOf>, ops: CanvasOperation[]) {
  doc.transact(() => writeOperations(objects, ops));
}

describe('Yjs representation of objects', () => {
  it('round-trips every object type through Yjs unchanged', () => {
    const { doc, objects } = fresh();
    const all: CanvasObject[] = [
      rect(1),
      text(2, 'Hello\nworld'),
      {
        id: uuid(3),
        type: 'ellipse',
        x: 1,
        y: 2,
        width: 30,
        height: 40,
        fill: '#ddf4ff',
        ...style,
      },
      { id: uuid(4), type: 'line', x: 0, y: 0, dx: 9, dy: -4, ...style },
      { id: uuid(5), type: 'arrow', x: 3, y: 3, dx: 1, dy: 1, ...style },
      {
        id: uuid(6),
        type: 'pen',
        x: 7,
        y: 8,
        points: [
          { x: 0, y: 0 },
          { x: 2, y: 3 },
        ],
        ...style,
      },
    ];

    write(doc, objects, [{ type: 'insert', index: 0, objects: all }]);

    expect(readOrderedObjects(objects)).toEqual({ objects: all, invalidIds: [] });
  });

  it('stores text in a Y.Text so concurrent edits can merge', () => {
    const { doc, objects } = fresh();
    write(doc, objects, [{ type: 'insert', index: 0, objects: [text(1, 'abc')] }]);

    const map = objects.get(uuid(1));
    expect(map?.get('text')).toBeInstanceOf(Y.Text);
    expect(map?.get('text')?.toString()).toBe('abc');
  });

  it('keeps every object in the requested z-order with dense order values', () => {
    const { doc, objects } = fresh();
    write(doc, objects, [{ type: 'insert', index: 0, objects: [rect(1), rect(2)] }]);
    write(doc, objects, [{ type: 'insert', index: 0, objects: [rect(3)] }]);

    expect(readOrderedObjects(objects).objects.map((object) => object.id)).toEqual([
      uuid(3),
      uuid(1),
      uuid(2),
    ]);
    expect([uuid(3), uuid(1), uuid(2)].map((id) => objects.get(id)?.get('z'))).toEqual([
      0, 1, 2,
    ]);
    expect(consistencyProblems(objects)).toEqual([]);
  });

  it('applies field updates and text updates as changes to the existing entry', () => {
    const { doc, objects } = fresh();
    write(doc, objects, [{ type: 'insert', index: 0, objects: [rect(1), text(2, 'one two')] }]);

    write(doc, objects, [
      { type: 'update', id: uuid(1), changes: { x: 40 } },
      { type: 'update', id: uuid(2), changes: { text: 'ONE two' } },
    ]);

    const [moved, edited] = readOrderedObjects(objects).objects;
    expect(moved).toMatchObject({ x: 40 });
    expect(edited).toMatchObject({ text: 'ONE two' });
    expect(objects.get(uuid(2))?.get('text')?.toString()).toBe('ONE two');
  });

  it('removes entries and keeps the rest in order', () => {
    const { doc, objects } = fresh();
    write(doc, objects, [{ type: 'insert', index: 0, objects: [rect(1), rect(2), rect(3)] }]);
    write(doc, objects, [{ type: 'remove', ids: [uuid(2)] }]);

    expect(readOrderedObjects(objects).objects.map((object) => object.id)).toEqual([
      uuid(1),
      uuid(3),
    ]);
    expect(consistencyProblems(objects)).toEqual([]);
  });
});

describe('operations against the Yjs document', () => {
  it('rejects operations that do not fit the document', () => {
    const { doc, objects } = fresh();
    write(doc, objects, [{ type: 'insert', index: 0, objects: [rect(1)] }]);

    expect(() =>
      doc.transact(() =>
        writeOperations(objects, [{ type: 'insert', index: 0, objects: [rect(1)] }]),
      ),
    ).toThrow(OperationError);
    expect(() =>
      doc.transact(() => writeOperations(objects, [{ type: 'remove', ids: [uuid(9)] }])),
    ).toThrow(OperationError);
    expect(() =>
      doc.transact(() =>
        writeOperations(objects, [{ type: 'update', id: uuid(9), changes: { x: 1 } }]),
      ),
    ).toThrow(OperationError);
    expect(() =>
      doc.transact(() => writeOperations(objects, [{ type: 'reorder', ids: [] }])),
    ).toThrow(OperationError);
  });
});

describe('reading malformed entries', () => {
  it('reports an entry that is not a valid object instead of throwing', () => {
    const { doc, objects } = fresh();
    write(doc, objects, [{ type: 'insert', index: 0, objects: [rect(1)] }]);
    doc.transact(() => {
      const broken: ObjectMap = new Y.Map<unknown>();
      broken.set('type', 'sticky-note');
      broken.set('z', 1);
      objects.set(uuid(2), broken);
    });

    const result = readOrderedObjects(objects);

    expect(result.objects.map((object) => object.id)).toEqual([uuid(1)]);
    expect(result.invalidIds).toEqual([uuid(2)]);
    expect(consistencyProblems(objects)).toEqual([
      `object ${uuid(2)} is not a valid canvas object`,
    ]);
  });

  it('orders entries with equal order values by id, the same way on every replica', () => {
    const { doc, objects } = fresh();
    doc.transact(() => {
      for (const n of [3, 1, 2]) {
        const map: ObjectMap = new Y.Map<unknown>();
        const fields: Record<string, unknown> = rect(n);
        for (const key of Object.keys(fields)) {
          if (key !== 'id') {
            map.set(key, fields[key]);
          }
        }
        map.set('z', 0);
        objects.set(uuid(n), map);
      }
    });

    expect(readOrderedObjects(objects).objects.map((object) => object.id)).toEqual([
      uuid(1),
      uuid(2),
      uuid(3),
    ]);
    expect(consistencyProblems(objects).length).toBeGreaterThan(0);
  });
});
