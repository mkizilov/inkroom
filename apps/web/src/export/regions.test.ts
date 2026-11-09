import { describe, expect, it } from 'vitest';
import type { CanvasObject } from '@inkroom/shared';
import { EMPTY_BOARD_REGION, EXPORT_MARGIN, selectForExport, unionOf } from './regions';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function rectangle(n: number, x: number, y: number, width = 100, height = 50): CanvasObject {
  return { id: id(n), type: 'rectangle', x, y, width, height, stroke: '#000000', strokeWidth: 2 };
}

const objects = [rectangle(1, 0, 0), rectangle(2, 400, 300), rectangle(3, 1000, 1000)];

describe('unionOf', () => {
  it('returns the smallest rectangle that holds all the given rectangles', () => {
    expect(
      unionOf([
        { x: 10, y: 20, width: 30, height: 40 },
        { x: -5, y: 50, width: 10, height: 10 },
      ]),
    ).toEqual({ x: -5, y: 20, width: 45, height: 40 });
  });

  it('returns null when there is nothing to hold', () => {
    expect(unionOf([])).toBeNull();
  });
});

describe('selectForExport', () => {
  it('exports the whole board, with a margin, and records no region', () => {
    const selection = selectForExport('board', objects, [], EMPTY_BOARD_REGION);

    expect(selection.objects).toEqual(objects);
    expect(selection.viewport).toEqual({
      x: -EXPORT_MARGIN,
      y: -EXPORT_MARGIN,
      width: 1100 + 2 * EXPORT_MARGIN,
      height: 1050 + 2 * EXPORT_MARGIN,
    });
    expect(selection.recordedRegion).toBeNull();
  });

  it('shows an empty board in the default area', () => {
    expect(selectForExport('board', [], [], EMPTY_BOARD_REGION).viewport).toEqual(
      EMPTY_BOARD_REGION,
    );
  });

  it('exports only the selected objects, framed around them', () => {
    const selection = selectForExport('selection', objects, [id(2)], EMPTY_BOARD_REGION);

    expect(selection.objects).toEqual([objects[1]]);
    expect(selection.viewport).toEqual({
      x: 400 - EXPORT_MARGIN,
      y: 300 - EXPORT_MARGIN,
      width: 100 + 2 * EXPORT_MARGIN,
      height: 50 + 2 * EXPORT_MARGIN,
    });
    expect(selection.recordedRegion).toEqual(selection.viewport);
  });

  it('exports every object that touches the region, whole, and keeps the region as given', () => {
    const region = { x: 350, y: 250, width: 200, height: 200 };

    const selection = selectForExport('region', objects, [], region);

    expect(selection.objects).toEqual([objects[1]]);
    expect(selection.viewport).toEqual(region);
    expect(selection.recordedRegion).toEqual(region);
  });
});

describe('region export of strokes', () => {
  const line = (n: number, x: number, y: number, dx: number, dy: number): CanvasObject => ({
    id: id(n),
    type: 'line',
    x,
    y,
    dx,
    dy,
    stroke: '#000000',
    strokeWidth: 2,
  });

  it('leaves out a diagonal stroke whose box overlaps the region but whose line never reaches it', () => {
    // The line runs from (0, 0) to (100, 100). Its box overlaps the region at x 90 to 140 and y 0 to
    // 10, but where the line has x of 90 or more, its y is 90 or more.
    const selection = selectForExport('region', [line(1, 0, 0, 100, 100)], [], {
      x: 90,
      y: 0,
      width: 50,
      height: 10,
    });

    expect(selection.objects).toEqual([]);
  });

  it('keeps a diagonal stroke that crosses the region', () => {
    const selection = selectForExport('region', [line(1, 0, 0, 100, 100)], [], {
      x: 40,
      y: 40,
      width: 10,
      height: 10,
    });

    expect(selection.objects.map((object) => object.id)).toEqual([id(1)]);
  });
});

describe('region export of the representative board', () => {
  // The objects of the browser test's board in apps/web/e2e/import-export.spec.ts, with the same
  // coordinates, and the browser test's region.
  const board: CanvasObject[] = [
    {
      id: id(1),
      type: 'rectangle',
      x: 40,
      y: 40,
      width: 200,
      height: 120,
      stroke: '#1971c2',
      strokeWidth: 2,
      fill: '#a5d8ff',
    },
    {
      id: id(2),
      type: 'ellipse',
      x: 300,
      y: 60,
      width: 160,
      height: 100,
      stroke: '#2f9e44',
      strokeWidth: 3,
    },
    {
      id: id(3),
      type: 'arrow',
      x: 60,
      y: 220,
      dx: 220,
      dy: -60,
      stroke: '#e03131',
      strokeWidth: 2,
    },
    { id: id(4), type: 'line', x: 300, y: 260, dx: 180, dy: 0, stroke: '#1e1e1e', strokeWidth: 1 },
    {
      id: id(5),
      type: 'pen',
      x: 520,
      y: 80,
      points: [
        { x: 0, y: 0 },
        { x: 20, y: -15 },
        { x: 40, y: 5 },
        { x: 60, y: -10 },
      ],
      stroke: '#6741d9',
      strokeWidth: 3,
    },
    {
      id: id(6),
      type: 'text',
      x: 60,
      y: 340,
      text: 'Roadmap\nQ3 & Q4',
      stroke: '#1e1e1e',
      strokeWidth: 1,
      fontSize: 24,
    },
  ];

  it('keeps the ellipse, and the arrow whose rounded tip reaches the region corner', () => {
    // Region x 280 to 480, y 40 to 160. The rectangle ends at x 240, the line is at y 260, the pen is
    // at x 518 or more, and the text is at y 340 or more: all are outside. The ellipse lies inside. The
    // arrow ends at (280, 160), the region's bottom-left corner, and its round end reaches 1 unit past
    // that point, so its drawn stroke overlaps the corner.
    const region = { x: 280, y: 40, width: 200, height: 120 };

    expect(selectForExport('region', board, [], region).objects.map((object) => object.id)).toEqual(
      [id(2), id(3)],
    );
  });
});
