import { describe, expect, it } from 'vitest';
import type { CanvasObject } from '@inkroom/shared';
import { EMPTY_HISTORY, recordChange, redoChange, undoChange } from './history';

const style = { stroke: '#000000', strokeWidth: 2 };
const id = (value: string) => `00000000-0000-4000-8000-00000000000${value}`;
const rect = (x: number): CanvasObject => ({
  id: id('1'),
  type: 'rectangle',
  x,
  y: 0,
  width: 10,
  height: 10,
  ...style,
});

describe('history steps', () => {
  it('records nothing when the document has not changed', () => {
    const document = [rect(0)];
    expect(recordChange(EMPTY_HISTORY, document, document)).toBe(EMPTY_HISTORY);
  });

  it('undoes and redoes a recorded change', () => {
    const history = recordChange(EMPTY_HISTORY, [rect(0)], [rect(5)]);

    const undone = undoChange([rect(5)], history);
    expect(undone?.objects).toEqual([rect(0)]);
    expect(undone?.history.future).toHaveLength(1);

    const redone = redoChange(undone?.objects ?? [], undone?.history ?? EMPTY_HISTORY);
    expect(redone?.objects).toEqual([rect(5)]);
  });

  it('returns null when there is nothing to undo or redo', () => {
    expect(undoChange([rect(0)], EMPTY_HISTORY)).toBeNull();
    expect(redoChange([rect(0)], EMPTY_HISTORY)).toBeNull();
  });

  it('discards the redo stack when a new change is recorded', () => {
    const first = recordChange(EMPTY_HISTORY, [rect(0)], [rect(5)]);
    const undone = undoChange([rect(5)], first);
    const branched = recordChange(undone?.history ?? EMPTY_HISTORY, [rect(0)], [rect(9)]);

    expect(branched.future).toEqual([]);
    expect(branched.past).toHaveLength(1);
  });
});
