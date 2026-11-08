import type { CanvasObject } from '@inkroom/shared';

// Deterministic boards for the benchmarks. The same count and seed always give the same objects, so
// runs can be compared with each other and across code versions. The mix is a plausible whiteboard:
// mostly shapes and text, with some lines, arrows and freehand strokes. The board grows with the
// object count, at about one object per cell.

// A small seeded generator (mulberry32). Used only to make fixtures repeatable.
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLORS = ['#1971c2', '#2f9e44', '#e03131', '#f08c00', '#6741d9', '#1e1e1e'];
const WORDS = ['plan', 'review', 'idea', 'todo', 'draft', 'sketch', 'owner', 'ship', 'check'];
const CELL = 220;

export function boardSide(count: number): number {
  return Math.ceil(Math.sqrt(count)) * CELL;
}

export function objectId(index: number): string {
  return `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`;
}

function pick<T>(items: readonly T[], roll: number): T {
  const item = items[Math.floor(roll * items.length)];
  if (item === undefined) {
    throw new Error('pick needs a non-empty list');
  }
  return item;
}

function penPoints(random: () => number): Array<{ x: number; y: number }> {
  const count = 10 + Math.floor(random() * 111);
  const points: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
  for (let index = 1; index < count; index += 1) {
    const previous = points[index - 1];
    if (previous === undefined) {
      throw new Error('a pen stroke starts with a point');
    }
    points.push({ x: previous.x + random() * 8 - 3, y: previous.y + random() * 8 - 3 });
  }
  return points;
}

function objectAt(index: number, x: number, y: number, random: () => number): CanvasObject {
  const id = objectId(index);
  const stroke = pick(COLORS, random());
  const strokeWidth = 1 + Math.floor(random() * 5);
  const roll = random();
  if (roll < 0.3) {
    const filled = random() < 0.3;
    return {
      id,
      type: 'rectangle',
      x,
      y,
      width: 60 + random() * 100,
      height: 40 + random() * 70,
      stroke,
      strokeWidth,
      ...(filled ? { fill: pick(COLORS, random()) } : {}),
    };
  }
  if (roll < 0.45) {
    return {
      id,
      type: 'ellipse',
      x,
      y,
      width: 60 + random() * 100,
      height: 40 + random() * 70,
      stroke,
      strokeWidth,
    };
  }
  if (roll < 0.65) {
    const length = 3 + Math.floor(random() * 28);
    let text = '';
    while (text.length < length) {
      text += `${pick(WORDS, random())} `;
    }
    return {
      id,
      type: 'text',
      x,
      y,
      text: text.slice(0, length).trim(),
      stroke,
      strokeWidth,
      fontSize: 12 + Math.floor(random() * 29),
    };
  }
  if (roll < 0.75) {
    return {
      id,
      type: 'line',
      x,
      y,
      dx: 30 + random() * 120,
      dy: random() * 120 - 60,
      stroke,
      strokeWidth,
    };
  }
  if (roll < 0.85) {
    return {
      id,
      type: 'arrow',
      x,
      y,
      dx: 30 + random() * 120,
      dy: random() * 120 - 60,
      stroke,
      strokeWidth,
    };
  }
  return { id, type: 'pen', x, y, points: penPoints(random), stroke, strokeWidth };
}

// `count` objects in back-to-front order, deterministic for a given count and seed.
export function generateBoard(count: number, seed = 1): CanvasObject[] {
  const random = prng(seed);
  const columns = Math.ceil(Math.sqrt(count));
  const objects: CanvasObject[] = [];
  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = column * CELL + random() * (CELL - 160);
    const y = row * CELL + random() * (CELL - 120);
    objects.push(objectAt(index, x, y, random));
  }
  return objects;
}
