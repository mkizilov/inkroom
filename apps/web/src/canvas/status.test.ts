import { describe, expect, it } from 'vitest';
import type { CanvasObject } from '@inkroom/shared';
import { describeCanvas } from './status';

const style = { stroke: '#000000', strokeWidth: 2 };
const id = (value: string) => `00000000-0000-4000-8000-00000000000${value}`;
const rect = (value: string, x: number, width: number, height: number): CanvasObject => ({
  id: id(value),
  type: 'rectangle',
  x,
  y: 4,
  width,
  height,
  ...style,
});

describe('describeCanvas', () => {
  it('counts objects with the correct plural', () => {
    expect(describeCanvas([], [])).toBe('0 objects');
    expect(describeCanvas([rect('1', 0, 10, 10)], [])).toBe('1 object');
  });

  it('describes the selection size and position, rounded for display', () => {
    const objects = [rect('1', 10.4, 60.2, 39.8)];
    expect(describeCanvas(objects, [id('1')])).toBe('1 object · 1 selected · 60 × 40 at 10, 4');
  });

  it('spans every selected object in the bounds', () => {
    const objects = [rect('1', 0, 10, 10), rect('2', 50, 10, 10)];
    expect(describeCanvas(objects, [id('1'), id('2')])).toBe(
      '2 objects · 2 selected · 60 × 10 at 0, 4',
    );
  });

  it('ignores selected ids that are no longer in the document', () => {
    expect(describeCanvas([rect('1', 0, 10, 10)], [id('9')])).toBe('1 object · 1 selected');
  });
});
