import { describe, expect, it } from 'vitest';
import { parseBoardExport, type CanvasObject } from '@inkroom/shared';
import { ExportError, buildJsonText, exportFileName, pngSizeError } from './build';
import { EMPTY_BOARD_REGION, selectForExport } from './regions';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const exportedAt = '2026-01-02T09:30:00.000Z';

const objects: CanvasObject[] = [
  {
    id: id(1),
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    stroke: '#1971c2',
    strokeWidth: 2,
    fill: '#a5d8ff',
  },
  {
    id: id(2),
    type: 'text',
    x: 300,
    y: 120,
    text: 'Two\nlines & <markup>',
    stroke: '#1e1e1e',
    strokeWidth: 1,
    fontSize: 18,
  },
];

describe('JSON export', () => {
  it('reads back with the same objects, in the same order, and the same title', () => {
    const selection = selectForExport('board', objects, [], EMPTY_BOARD_REGION);

    const parsed = parseBoardExport(buildJsonText('Sprint 4', selection, exportedAt));

    expect(parsed.title).toBe('Sprint 4');
    expect(parsed.objects).toEqual(objects);
    expect(parsed.region).toBeNull();
  });

  it('records the region of a region export, and exports only the objects in it', () => {
    const region = { x: 290, y: 110, width: 200, height: 100 };
    const selection = selectForExport('region', objects, [], region);

    const parsed = parseBoardExport(buildJsonText('Sprint 4', selection, exportedAt));

    expect(parsed.region).toEqual(region);
    expect(parsed.objects).toEqual([objects[1]]);
  });

  it('exports the selected objects only', () => {
    const selection = selectForExport('selection', objects, [id(2)], EMPTY_BOARD_REGION);

    expect(parseBoardExport(buildJsonText('Sprint 4', selection, exportedAt)).objects).toEqual([
      objects[1],
    ]);
  });

  it('refuses an export larger than an import can accept', () => {
    const points = Array.from({ length: 10_000 }, () => ({ x: 1234.5678, y: 9876.5432 }));
    const pens: CanvasObject[] = Array.from({ length: 30 }, (_, index): CanvasObject => ({
      id: id(index + 1),
      type: 'pen',
      x: 0,
      y: 0,
      points,
      stroke: '#000000',
      strokeWidth: 1,
    }));
    const selection = selectForExport('board', pens, [], EMPTY_BOARD_REGION);

    expect(() => buildJsonText('Too large', selection, exportedAt)).toThrow(ExportError);
  }, 60_000);
});

describe('PNG size limit', () => {
  it('allows a picture at the limit and refuses one past it', () => {
    expect(pngSizeError({ x: 0, y: 0, width: 800, height: 600 }, 2)).toBeNull();
    expect(pngSizeError({ x: 0, y: 0, width: 5000, height: 5000 }, 1)).toBeNull();
    expect(pngSizeError({ x: 0, y: 0, width: 6000, height: 6000 }, 1)).toMatch(
      /Choose a smaller region/,
    );
  });
});

describe('exportFileName', () => {
  it('names a whole-board export after the title', () => {
    expect(exportFileName('Sprint 4 — Plans', 'board', 'json')).toBe('sprint-4-plans.json');
  });

  it('names a selection or a region export with its scope', () => {
    expect(exportFileName('  Sprint  ', 'selection', 'svg')).toBe('sprint-selection.svg');
    expect(exportFileName('Sprint', 'region', 'png')).toBe('sprint-region.png');
  });

  it('falls back to a plain name when the title has no letters or digits', () => {
    expect(exportFileName('***', 'board', 'json')).toBe('board.json');
  });
});
