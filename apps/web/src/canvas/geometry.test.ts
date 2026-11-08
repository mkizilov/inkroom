import { describe, expect, it } from 'vitest';
import type { CanvasObject } from '@inkroom/shared';
import {
  containsPoint,
  distanceToSegment,
  hitTest,
  normalizeRect,
  objectBounds,
  objectsInRect,
  pickObject,
  rectsIntersect,
} from './geometry';

const style = { stroke: '#000000', strokeWidth: 2 };
const id = (value: string) => `00000000-0000-4000-8000-00000000000${value}`;

const rect: CanvasObject = {
  id: id('1'),
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  ...style,
};
const filledRect: CanvasObject = { ...rect, id: id('2'), x: 200, fill: '#ffffff' };
const ellipse: CanvasObject = {
  id: id('3'),
  type: 'ellipse',
  x: 400,
  y: 0,
  width: 100,
  height: 100,
  ...style,
};
const line: CanvasObject = { id: id('4'), type: 'line', x: 0, y: 200, dx: 100, dy: 100, ...style };
const arrow: CanvasObject = { id: id('5'), type: 'arrow', x: 300, y: 300, dx: 0, dy: 80, ...style };
const pen: CanvasObject = {
  id: id('6'),
  type: 'pen',
  x: 500,
  y: 500,
  points: [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 50, y: 50 },
  ],
  ...style,
};
const text: CanvasObject = {
  id: id('7'),
  type: 'text',
  x: 700,
  y: 700,
  text: 'Hi',
  fontSize: 20,
  ...style,
};

describe('rectangles', () => {
  it('normalizes a rectangle dragged in any direction', () => {
    expect(normalizeRect({ x: 50, y: 40 }, { x: 10, y: 5 })).toEqual({
      x: 10,
      y: 5,
      width: 40,
      height: 35,
    });
  });

  it('treats touching rectangles as intersecting and separated ones as not', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsIntersect(a, { x: 10, y: 10, width: 5, height: 5 })).toBe(true);
    expect(rectsIntersect(a, { x: 11, y: 0, width: 5, height: 5 })).toBe(false);
  });

  it('includes points on the edge', () => {
    expect(containsPoint({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0 })).toBe(true);
    expect(containsPoint({ x: 0, y: 0, width: 10, height: 10 }, { x: 10.1, y: 0 })).toBe(false);
  });
});

describe('object bounds', () => {
  it('uses the stored box for rectangles and ellipses', () => {
    expect(objectBounds(rect)).toEqual({ x: 0, y: 0, width: 100, height: 60 });
    expect(objectBounds(ellipse)).toEqual({ x: 400, y: 0, width: 100, height: 100 });
  });

  it('includes half the stroke width around lines and pen strokes', () => {
    expect(objectBounds(line)).toEqual({ x: -1, y: 199, width: 102, height: 102 });
    expect(objectBounds(pen)).toEqual({ x: 499, y: 499, width: 52, height: 52 });
  });

  it('estimates text bounds from its length and font size', () => {
    const bounds = objectBounds(text);
    expect(bounds.x).toBe(700);
    expect(bounds.y).toBe(700);
    expect(bounds.width).toBeCloseTo(2 * 20 * 0.6, 9);
    expect(bounds.height).toBeCloseTo(20 * 1.2, 9);
  });
});

describe('hit testing', () => {
  it('hits the outline of an unfilled rectangle but not its interior', () => {
    expect(hitTest(rect, { x: 0, y: 30 }, 0)).toBe(true);
    expect(hitTest(rect, { x: 50, y: 30 }, 0)).toBe(false);
  });

  it('hits the interior of a filled rectangle', () => {
    expect(hitTest(filledRect, { x: 250, y: 30 }, 0)).toBe(true);
    expect(hitTest(filledRect, { x: 350, y: 30 }, 0)).toBe(false);
  });

  it('uses the tolerance to widen the hit area', () => {
    expect(hitTest(rect, { x: -4, y: 30 }, 0)).toBe(false);
    expect(hitTest(rect, { x: -4, y: 30 }, 5)).toBe(true);
  });

  it('hits the outline of an ellipse, and the interior only when filled', () => {
    expect(hitTest(ellipse, { x: 450, y: 0 }, 0)).toBe(true);
    expect(hitTest(ellipse, { x: 450, y: 50 }, 0)).toBe(false);
    expect(hitTest({ ...ellipse, fill: '#ffffff' }, { x: 450, y: 50 }, 0)).toBe(true);
  });

  it('hits lines and arrows near their segment', () => {
    expect(hitTest(line, { x: 50, y: 250 }, 0)).toBe(true);
    expect(hitTest(line, { x: 50, y: 300 }, 0)).toBe(false);
    expect(hitTest(arrow, { x: 300, y: 340 }, 0)).toBe(true);
  });

  it('hits pen strokes along any segment of the polyline', () => {
    expect(hitTest(pen, { x: 550, y: 500 }, 0)).toBe(true);
    expect(hitTest(pen, { x: 550, y: 550 }, 0)).toBe(true);
    expect(hitTest(pen, { x: 530, y: 530 }, 0)).toBe(false);
  });

  it('hits text inside its estimated box', () => {
    expect(hitTest(text, { x: 710, y: 710 }, 0)).toBe(true);
    expect(hitTest(text, { x: 900, y: 710 }, 0)).toBe(false);
  });

  it('measures point-to-segment distance, including past the endpoints', () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('selection queries', () => {
  it('picks the topmost object under the point', () => {
    const under: CanvasObject = { ...filledRect, id: id('9'), x: 0, y: 0 };
    const over: CanvasObject = { ...filledRect, id: id('8'), x: 10, y: 10 };
    expect(pickObject([under, over], { x: 20, y: 20 }, 0)?.id).toBe(id('8'));
    expect(pickObject([over, under], { x: 20, y: 20 }, 0)?.id).toBe(id('9'));
  });

  it('returns nothing when no object is under the point', () => {
    expect(pickObject([rect], { x: 500, y: 500 }, 2)).toBeUndefined();
  });

  it('selects objects whose bounds touch the marquee', () => {
    const hits = objectsInRect([rect, ellipse, text], { x: -10, y: -10, width: 150, height: 150 });
    expect(hits.map((object) => object.id)).toEqual([id('1')]);
  });
});
