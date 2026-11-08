import type { CanvasObject, Point } from '@inkroom/shared';
import { geometricBounds, type Rect } from './geometry';

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export const HANDLE_SIZE_PX = 8;

const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 400;

function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) {
    return null;
  }
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// The box that encloses the selected objects' own geometry. Null when nothing is selected.
export function selectionBounds(
  objects: readonly CanvasObject[],
  ids: readonly string[],
): Rect | null {
  const selected = new Set(ids);
  return unionRects(objects.filter((object) => selected.has(object.id)).map(geometricBounds));
}

export function handlePoint(box: Rect, handle: Handle): Point {
  const x = handle.includes('w')
    ? box.x
    : handle.includes('e')
      ? box.x + box.width
      : box.x + box.width / 2;
  const y = handle.includes('n')
    ? box.y
    : handle.includes('s')
      ? box.y + box.height
      : box.y + box.height / 2;
  return { x, y };
}

// Returns the nearest handle within `tolerance` world units, or null.
export function handleAt(box: Rect, point: Point, tolerance: number): Handle | null {
  let best: { handle: Handle; distance: number } | null = null;
  for (const handle of HANDLES) {
    const anchor = handlePoint(box, handle);
    const distance = Math.hypot(point.x - anchor.x, point.y - anchor.y);
    if (distance <= tolerance && (!best || distance < best.distance)) {
      best = { handle, distance };
    }
  }
  return best?.handle ?? null;
}

// Moves the edges that the handle controls to the pointer. The opposite edges stay put, and no
// side can shrink below `minSize`.
export function resizeBox(start: Rect, handle: Handle, pointer: Point, minSize: number): Rect {
  let left = start.x;
  let right = start.x + start.width;
  let top = start.y;
  let bottom = start.y + start.height;

  if (handle.includes('w')) {
    left = Math.min(pointer.x, right - minSize);
  }
  if (handle.includes('e')) {
    right = Math.max(pointer.x, left + minSize);
  }
  if (handle.includes('n')) {
    top = Math.min(pointer.y, bottom - minSize);
  }
  if (handle.includes('s')) {
    bottom = Math.max(pointer.y, top + minSize);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function scaleFactor(from: number, to: number): number {
  // A selection with no extent on an axis (a vertical line, say) cannot be scaled along it.
  return from > 0 ? to / from : 1;
}

// Maps an object from one box to another. Every object type uses the same mapping, so a group
// moves and resizes as a unit. Text scales its font size with the height and keeps its width,
// which follows from the font.
export function scaleObjectInBox(object: CanvasObject, from: Rect, to: Rect): CanvasObject {
  const sx = scaleFactor(from.width, to.width);
  const sy = scaleFactor(from.height, to.height);
  const x = to.x + (object.x - from.x) * sx;
  const y = to.y + (object.y - from.y) * sy;

  switch (object.type) {
    case 'rectangle':
    case 'ellipse':
      return { ...object, x, y, width: object.width * sx, height: object.height * sy };
    case 'pen':
      return {
        ...object,
        x,
        y,
        points: object.points.map((point) => ({ x: point.x * sx, y: point.y * sy })),
      };
    case 'line':
    case 'arrow':
      return { ...object, x, y, dx: object.dx * sx, dy: object.dy * sy };
    case 'text':
      return {
        ...object,
        x,
        y,
        fontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, object.fontSize * sy)),
      };
  }
}

// Applies the box mapping to the selected objects and leaves the rest untouched.
export function transformObjects(
  objects: readonly CanvasObject[],
  ids: readonly string[],
  from: Rect,
  to: Rect,
): CanvasObject[] {
  const selected = new Set(ids);
  return objects.map((object) =>
    selected.has(object.id) ? scaleObjectInBox(object, from, to) : object,
  );
}
