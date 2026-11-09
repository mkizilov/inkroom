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
  touchesRect,
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

describe('touchesRect', () => {
  const line = (dx: number, dy: number, strokeWidth = 2): CanvasObject => ({
    id: id('a'),
    type: 'line',
    x: 0,
    y: 0,
    dx,
    dy,
    stroke: '#000000',
    strokeWidth,
  });

  it('counts a stroke that comes within half its width of the rectangle, and not one beyond', () => {
    // A horizontal line at y 50 with width 2 reaches y 51.
    const onEdge = { x: 0, y: 51, width: 10, height: 10 };
    const justBeyond = { x: 0, y: 51.01, width: 10, height: 10 };

    expect(touchesRect(line(100, 0), onEdge)).toBe(false);
    expect(touchesRect({ ...line(100, 0), y: 50 }, onEdge)).toBe(true);
    expect(touchesRect({ ...line(100, 0), y: 50 }, justBeyond)).toBe(false);
  });

  it('counts the rounded end of an arrow, which reaches half its width past the tip', () => {
    // The arrow from (60, 220) to (280, 160) ends at (280, 160). Its round end reaches x 281 at
    // that height, and no further.
    const arrow: CanvasObject = {
      id: id('b'),
      type: 'arrow',
      x: 60,
      y: 220,
      dx: 220,
      dy: -60,
      stroke: '#000000',
      strokeWidth: 2,
    };
    const reaches = { x: 281, y: 40, width: 199, height: 120 };
    const misses = { x: 281.01, y: 40, width: 199, height: 120 };

    expect(touchesRect(arrow, reaches)).toBe(true);
    expect(touchesRect(arrow, misses)).toBe(false);
  });

  it('counts an arrowhead through its filled interior, even when its edges miss the rectangle', () => {
    // The head of this arrow is the triangle (100, 0), (90, 5), (90, -5). The rectangle from y 1.5 to
    // 2.5 lies inside it, so no edge of the head reaches it, and the shaft (y 0, width 2) misses it too.
    // The rectangle from y 4.5 to 5.5 lies outside: the head's upper edge is at y 4 when x is 92.
    const arrow: CanvasObject = {
      id: id('c'),
      type: 'arrow',
      x: 0,
      y: 0,
      dx: 100,
      dy: 0,
      stroke: '#000000',
      strokeWidth: 2,
    };

    expect(touchesRect(arrow, { x: 92, y: 1.5, width: 1, height: 1 })).toBe(true);
    expect(touchesRect(arrow, { x: 92, y: 4.5, width: 1, height: 1 })).toBe(false);
  });

  it('leaves out a diagonal pen stroke whose box overlaps the rectangle but whose path does not', () => {
    const pen: CanvasObject = {
      id: id('d'),
      type: 'pen',
      x: 0,
      y: 0,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      stroke: '#000000',
      strokeWidth: 2,
    };

    expect(touchesRect(pen, { x: 90, y: 0, width: 50, height: 10 })).toBe(false);
    expect(touchesRect(pen, { x: 40, y: 40, width: 10, height: 10 })).toBe(true);
  });

  it('judges shapes by their box, with the edges included', () => {
    const box = { ...rect, x: 0, y: 0 };

    expect(touchesRect(box, { x: 100, y: 0, width: 10, height: 10 })).toBe(true);
    expect(touchesRect(box, { x: 100.5, y: 0, width: 10, height: 10 })).toBe(false);
  });
});
