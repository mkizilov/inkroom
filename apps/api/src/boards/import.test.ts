import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { objectsMapOf, readOrderedObjects, type CanvasObject } from '@inkroom/shared';
import { importUpdates } from './import';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Replays updates into a fresh document, the way the room does when a board loads.
function rebuild(updates: readonly Uint8Array[]): CanvasObject[] {
  const doc = new Y.Doc();
  for (const update of updates) {
    Y.applyUpdate(doc, update);
  }
  return readOrderedObjects(objectsMapOf(doc)).objects;
}

describe('importUpdates', () => {
  it('rebuilds the objects in the order they were given', () => {
    const objects: CanvasObject[] = [
      {
        id: id(1),
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        stroke: '#000000',
        strokeWidth: 1,
      },
      {
        id: id(2),
        type: 'text',
        x: 5,
        y: 7,
        text: 'top',
        stroke: '#111111',
        strokeWidth: 1,
        fontSize: 20,
      },
      { id: id(3), type: 'arrow', x: 1, y: 2, dx: 30, dy: -4, stroke: '#222222', strokeWidth: 2 },
    ];

    expect(rebuild(importUpdates(objects))).toEqual(objects);
  });

  it('splits a large board into several updates, each within the stored size limit', () => {
    const text = 'x'.repeat(1_000);
    const objects: CanvasObject[] = Array.from({ length: 2_000 }, (_, index): CanvasObject => ({
      id: id(index + 1),
      type: 'text',
      x: index,
      y: index * 2,
      text,
      stroke: '#000000',
      strokeWidth: 1,
      fontSize: 12,
    }));

    const updates = importUpdates(objects);

    expect(updates.length).toBeGreaterThan(1);
    for (const update of updates) {
      expect(update.byteLength).toBeLessThan(1024 * 1024);
    }
    expect(rebuild(updates)).toEqual(objects);
  });

  it('writes nothing for a board with no objects', () => {
    expect(importUpdates([])).toEqual([]);
  });
});
