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
