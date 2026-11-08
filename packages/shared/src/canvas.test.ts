import { describe, expect, it } from 'vitest';
import {
  CANVAS_FORMAT_VERSION,
  canvasObjectSchema,
  parseCanvasDocument,
  serializeCanvasDocument,
  type CanvasObject,
} from './canvas';

const base = { stroke: '#1f2328', strokeWidth: 2 };

const objects: CanvasObject[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'pen',
    x: 10.5,
    y: -4,
    points: [
      { x: 0, y: 0 },
      { x: 12.25, y: 3 },
      { x: 20, y: -7.5 },
    ],
    ...base,
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 120,
    height: 80,
    ...base,
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    type: 'ellipse',
    x: 200,
    y: 200,
    width: 60,
    height: 30,
    fill: '#ddf4ff',
    ...base,
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    type: 'line',
    x: 5,
    y: 5,
    dx: -40,
    dy: 25,
    ...base,
  },
  {
    id: '00000000-0000-4000-8000-000000000005',
    type: 'arrow',
    x: 300,
    y: 10,
    dx: 100,
    dy: 0,
    ...base,
  },
  {
    id: '00000000-0000-4000-8000-000000000006',
    type: 'text',
    x: 50,
    y: 60,
    text: 'Hello\nworld',
    fontSize: 24,
    ...base,
  },
];

describe('canvas object serialization', () => {
  it('round-trips every object type without loss', () => {
    const json = serializeCanvasDocument(objects);

    expect(JSON.parse(json)).toMatchObject({ version: CANVAS_FORMAT_VERSION });
    expect(parseCanvasDocument(json).objects).toEqual(objects);
  });

  it('serializes an empty document', () => {
    expect(parseCanvasDocument(serializeCanvasDocument([])).objects).toEqual([]);
  });

  it('keeps world coordinates exactly as given', () => {
    const [pen] = parseCanvasDocument(serializeCanvasDocument(objects)).objects;
    expect(pen).toMatchObject({ x: 10.5, y: -4 });
  });

  it('refuses to serialize an object that breaks the schema', () => {
    const invalid = { ...objects[1], width: -1 } as CanvasObject;
    expect(() => serializeCanvasDocument([invalid])).toThrow();
  });

  it('rejects an unknown object type', () => {
    const json = JSON.stringify({
      version: 1,
      objects: [{ ...objects[1], type: 'sticky-note' }],
    });
    expect(() => parseCanvasDocument(json)).toThrow();
  });

  it('rejects non-finite coordinates, which JSON turns into null', () => {
    const json = JSON.stringify({
      version: 1,
      objects: [{ ...objects[1], x: Number.NaN }],
    });
    expect(() => parseCanvasDocument(json)).toThrow();
  });

  it('rejects malformed colors and out-of-range stroke widths', () => {
    expect(canvasObjectSchema.safeParse({ ...objects[1], stroke: 'red' }).success).toBe(false);
    expect(canvasObjectSchema.safeParse({ ...objects[1], strokeWidth: 0 }).success).toBe(false);
  });

  it('rejects pen objects with fewer than two points', () => {
    const pen = { ...objects[0], points: [{ x: 0, y: 0 }] };
    expect(canvasObjectSchema.safeParse(pen).success).toBe(false);
  });

  it('rejects text longer than the maximum length', () => {
    const text = { ...objects[5], text: 'x'.repeat(5001) };
    expect(canvasObjectSchema.safeParse(text).success).toBe(false);
  });

  it('rejects documents with duplicate object ids', () => {
    const json = JSON.stringify({
      version: 1,
      objects: [objects[1], { ...objects[2], id: objects[1]?.id }],
    });
    expect(() => parseCanvasDocument(json)).toThrow(/unique/);
  });

  it('rejects unsupported format versions', () => {
    expect(() => parseCanvasDocument(JSON.stringify({ version: 2, objects: [] }))).toThrow();
  });

  it('rejects input that is not JSON', () => {
    expect(() => parseCanvasDocument('{not json')).toThrow();
  });
});
