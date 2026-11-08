import { describe, expect, it } from 'vitest';
import type { CanvasObject } from '@inkroom/shared';
import type { Rect } from './geometry';
import {
  handleAt,
  handlePoint,
  resizeBox,
  scaleObjectInBox,
  selectionBounds,
  transformObjects,
} from './transform';

const style = { stroke: '#000000', strokeWidth: 2 };
const id = (value: string) => `00000000-0000-4000-8000-00000000000${value}`;
const box: Rect = { x: 0, y: 0, width: 100, height: 60 };

describe('selection bounds', () => {
  it('encloses the selected objects without stroke padding', () => {
    const objects: CanvasObject[] = [
      { id: id('1'), type: 'rectangle', x: 0, y: 0, width: 100, height: 60, ...style },
      { id: id('2'), type: 'line', x: 0, y: 200, dx: 100, dy: 100, ...style },
    ];

    expect(selectionBounds(objects, [id('2')])).toEqual({
      x: 0,
      y: 200,
      width: 100,
      height: 100,
    });
    expect(selectionBounds(objects, [id('1'), id('2')])).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 300,
    });
  });

  it('returns null when nothing is selected', () => {
    expect(selectionBounds([], [])).toBeNull();
  });
});

describe('handles', () => {
  it('places eight handles on the corners and edge midpoints', () => {
    expect(handlePoint(box, 'nw')).toEqual({ x: 0, y: 0 });
    expect(handlePoint(box, 'n')).toEqual({ x: 50, y: 0 });
    expect(handlePoint(box, 'ne')).toEqual({ x: 100, y: 0 });
    expect(handlePoint(box, 'e')).toEqual({ x: 100, y: 30 });
    expect(handlePoint(box, 'se')).toEqual({ x: 100, y: 60 });
    expect(handlePoint(box, 's')).toEqual({ x: 50, y: 60 });
    expect(handlePoint(box, 'sw')).toEqual({ x: 0, y: 60 });
    expect(handlePoint(box, 'w')).toEqual({ x: 0, y: 30 });
  });

  it('finds the nearest handle within the tolerance and nothing beyond it', () => {
    expect(handleAt(box, { x: 98, y: 58 }, 4)).toBe('se');
    expect(handleAt(box, { x: 50, y: 50 }, 4)).toBeNull();
  });
});

describe('resizeBox', () => {
  it('moves only the edges the handle controls', () => {
    expect(resizeBox(box, 'se', { x: 150, y: 90 }, 1)).toEqual({
      x: 0,
      y: 0,
      width: 150,
      height: 90,
    });
    expect(resizeBox(box, 'nw', { x: -20, y: -10 }, 1)).toEqual({
      x: -20,
      y: -10,
      width: 120,
      height: 70,
    });
    expect(resizeBox(box, 'e', { x: 130, y: 500 }, 1)).toEqual({
      x: 0,
      y: 0,
      width: 130,
      height: 60,
    });
  });

  it('never shrinks an axis below the minimum size', () => {
    expect(resizeBox(box, 'n', { x: 0, y: 200 }, 1)).toEqual({
      x: 0,
      y: 59,
      width: 100,
      height: 1,
    });
  });
});

describe('scaleObjectInBox', () => {
  const doubled: Rect = { x: 0, y: 0, width: 200, height: 120 };

  it('scales rectangles and ellipses to the new box', () => {
    const rect: CanvasObject = {
      id: id('1'),
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      ...style,
    };
    const ellipse: CanvasObject = {
      id: id('2'),
      type: 'ellipse',
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      ...style,
    };

    expect(scaleObjectInBox(rect, box, doubled)).toMatchObject({
      x: 0,
      y: 0,
      width: 200,
      height: 120,
    });
    expect(scaleObjectInBox(ellipse, box, doubled)).toMatchObject({ width: 200, height: 120 });
  });

  it('scales pen points relative to the new origin', () => {
    const pen: CanvasObject = {
      id: id('3'),
      type: 'pen',
      x: 10,
      y: 10,
      points: [
        { x: 0, y: 0 },
        { x: 40, y: 20 },
      ],
      ...style,
    };
    const scaled = scaleObjectInBox(
      pen,
      { x: 10, y: 10, width: 40, height: 20 },
      { x: 0, y: 0, width: 80, height: 40 },
    );

    expect(scaled.type === 'pen' && scaled.points[1]).toEqual({ x: 80, y: 40 });
    expect(scaled).toMatchObject({ x: 0, y: 0 });
  });

  it('scales line and arrow end points', () => {
    const line: CanvasObject = {
      id: id('4'),
      type: 'line',
      x: 0,
      y: 0,
      dx: 50,
      dy: 10,
      ...style,
    };
    const scaled = scaleObjectInBox(
      line,
      { x: 0, y: 0, width: 50, height: 10 },
      { x: 0, y: 0, width: 100, height: 5 },
    );

    expect(scaled).toMatchObject({ dx: 100, dy: 5 });
  });

  it('scales text font size with the height and clamps it', () => {
    const text: CanvasObject = {
      id: id('5'),
      type: 'text',
      x: 0,
      y: 0,
      text: 'Hi',
      fontSize: 24,
      ...style,
    };
    const half = scaleObjectInBox(text, box, { x: 0, y: 0, width: 100, height: 30 });
    const huge = scaleObjectInBox(text, box, { x: 0, y: 0, width: 100, height: 6000 });

    expect(half).toMatchObject({ fontSize: 12 });
    expect(huge).toMatchObject({ fontSize: 400 });
  });

  it('translates an object when the box only moves', () => {
    const rect: CanvasObject = {
      id: id('1'),
      type: 'rectangle',
      x: 20,
      y: 5,
      width: 30,
      height: 30,
      ...style,
    };
    expect(scaleObjectInBox(rect, box, { ...box, x: 15, y: -5 })).toMatchObject({
      x: 35,
      y: 0,
      width: 30,
      height: 30,
    });
  });

  it('leaves an axis with no extent unscaled', () => {
    const vertical: CanvasObject = {
      id: id('6'),
      type: 'line',
      x: 0,
      y: 0,
      dx: 0,
      dy: 50,
      ...style,
    };
    const scaled = scaleObjectInBox(
      vertical,
      { x: 0, y: 0, width: 0, height: 50 },
      { x: 0, y: 0, width: 10, height: 100 },
    );

    expect(scaled).toMatchObject({ dx: 0, dy: 100 });
  });
});

describe('transformObjects', () => {
  it('changes only the selected objects', () => {
    const objects: CanvasObject[] = [
      { id: id('1'), type: 'rectangle', x: 0, y: 0, width: 100, height: 60, ...style },
      { id: id('2'), type: 'rectangle', x: 200, y: 0, width: 100, height: 60, ...style },
    ];
    const result = transformObjects(objects, [id('1')], box, { ...box, x: 10 });

    expect(result[0]).toMatchObject({ x: 10 });
    expect(result[1]).toBe(objects[1]);
  });
});
