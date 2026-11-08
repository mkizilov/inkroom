import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  BOARD_EXPORT_VERSION,
  parseBoardExport,
  serializeBoardExport,
  type BoardExportInput,
} from './board-export';
import { MAX_CANVAS_OBJECTS, type CanvasObject } from './canvas';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// One of each object type, with the values that are easy to lose: negative and fractional
// coordinates, a fill, pen points relative to the object, and text with markup and a line break.
const objects: CanvasObject[] = [
  {
    id: id(1),
    type: 'rectangle',
    x: 10,
    y: 20,
    width: 100,
    height: 60,
    stroke: '#1971c2',
    strokeWidth: 2,
    fill: '#a5d8ff',
  },
  {
    id: id(2),
    type: 'ellipse',
    x: -40,
    y: 5.5,
    width: 80,
    height: 30,
    stroke: '#2f9e44',
    strokeWidth: 3,
  },
  {
    id: id(3),
    type: 'pen',
    x: 200,
    y: 200,
    points: [
      { x: 0, y: 0 },
      { x: 5.25, y: -3 },
      { x: 12, y: 4 },
    ],
    stroke: '#000000',
    strokeWidth: 1,
  },
  { id: id(4), type: 'line', x: 0, y: 0, dx: 120, dy: -45, stroke: '#000000', strokeWidth: 2 },
  { id: id(5), type: 'arrow', x: 300, y: 40, dx: -60, dy: 90, stroke: '#e03131', strokeWidth: 2 },
  {
    id: id(6),
    type: 'text',
    x: 50,
    y: 400,
    text: 'Café <b>"notes"</b>\nline two & more',
    stroke: '#1e1e1e',
    strokeWidth: 1,
    fontSize: 24,
  },
];

const input: BoardExportInput = {
  title: 'Sprint 4',
  objects,
  region: null,
  exportedAt: '2026-01-02T09:30:00.000Z',
};

describe('board export round trip', () => {
  it('keeps every object type, its coordinates, its text and the stacking order', () => {
    const parsed = parseBoardExport(serializeBoardExport(input));

    expect(parsed.objects).toEqual(objects);
    expect(parsed.title).toBe('Sprint 4');
    expect(parsed.region).toBeNull();
    expect(parsed.version).toBe(BOARD_EXPORT_VERSION);
  });

  it('serializes to the same text again after a round trip', () => {
    const text = serializeBoardExport(input);
    const parsed = parseBoardExport(text);

    expect(
      serializeBoardExport({
        title: parsed.title,
        objects: parsed.objects,
        region: parsed.region,
        exportedAt: parsed.exportedAt,
      }),
    ).toBe(text);
  });

  it('keeps the exported region', () => {
    const region = { x: -10, y: 0, width: 500, height: 300 };

    expect(parseBoardExport(serializeBoardExport({ ...input, region })).region).toEqual(region);
  });

  it('accepts a board with no objects', () => {
    expect(parseBoardExport(serializeBoardExport({ ...input, objects: [] })).objects).toEqual([]);
  });
});

describe('board export validation', () => {
  const asObject = (text: string): Record<string, unknown> =>
    JSON.parse(text) as Record<string, unknown>;

  it('refuses text that is not JSON', () => {
    expect(() => parseBoardExport('{"format":')).toThrow(SyntaxError);
  });

  it('refuses a version it does not know', () => {
    const value = asObject(serializeBoardExport(input));
    value.version = BOARD_EXPORT_VERSION + 1;

    expect(() => parseBoardExport(JSON.stringify(value))).toThrow(ZodError);
  });

  it('refuses a file that is not a board export', () => {
    const value = asObject(serializeBoardExport(input));
    const wrongFormat = { ...value, format: 'something-else' };
    const withoutObjects = { ...value, objects: undefined };
    const withExtraField = { ...value, anotherField: true };

    expect(() => parseBoardExport(JSON.stringify(wrongFormat))).toThrow(ZodError);
    expect(() => parseBoardExport(JSON.stringify(withoutObjects))).toThrow(ZodError);
    expect(() => parseBoardExport(JSON.stringify(withExtraField))).toThrow(ZodError);
  });

  it('refuses an unknown object type, an invalid colour and a blank title', () => {
    const value = asObject(serializeBoardExport(input));
    const unknownType = { ...value, objects: [{ ...objects[0], type: 'polygon' }] };
    const badColour = { ...value, objects: [{ ...objects[0], stroke: 'red' }] };
    const blankTitle = { ...value, title: '   ' };

    expect(() => parseBoardExport(JSON.stringify(unknownType))).toThrow(ZodError);
    expect(() => parseBoardExport(JSON.stringify(badColour))).toThrow(ZodError);
    expect(() => parseBoardExport(JSON.stringify(blankTitle))).toThrow(ZodError);
  });

  it('refuses two objects with the same id', () => {
    const value = asObject(serializeBoardExport(input));
    const duplicated = { ...value, objects: [objects[0], objects[0]] };

    expect(() => parseBoardExport(JSON.stringify(duplicated))).toThrow(ZodError);
  });

  it('refuses more objects than a board can hold', () => {
    const many = Array.from({ length: MAX_CANVAS_OBJECTS + 1 }, (_, index): CanvasObject => ({
      id: id(index + 1),
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      stroke: '#000000',
      strokeWidth: 1,
    }));

    expect(() => serializeBoardExport({ ...input, objects: many })).toThrow(ZodError);
    const value = asObject(serializeBoardExport(input));
    expect(() => parseBoardExport(JSON.stringify({ ...value, objects: many }))).toThrow(ZodError);
  });

  it('refuses to write an export that would not be accepted again', () => {
    const invalid = [{ ...objects[0], stroke: 'not-a-colour' } as CanvasObject];

    expect(() => serializeBoardExport({ ...input, objects: invalid })).toThrow(ZodError);
  });
});
