import type { CanvasObject, Point } from '@inkroom/shared';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Approximate text metrics for bounds and hit testing. Text is laid out by Konva with the
// default font, so these are estimates for picking, not exact glyph boxes.
const TEXT_CHAR_WIDTH = 0.6;
const TEXT_LINE_HEIGHT = 1.2;

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width &&
    b.x <= a.x + a.width &&
    a.y <= b.y + b.height &&
    b.y <= a.y + a.height
  );
}

export function containsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function expandRect(rect: Rect, amount: number): Rect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

function boundsOf(points: Point[], padding: number): Rect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX - padding,
    y: minY - padding,
    width: Math.max(...xs) - minX + padding * 2,
    height: Math.max(...ys) - minY + padding * 2,
  };
}

export function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - a.x, point.y - a.y);
  }
  const t = Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function distanceToPolyline(point: Point, vertices: Point[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < vertices.length - 1; index += 1) {
    const a = vertices[index];
    const b = vertices[index + 1];
    if (a && b) {
      best = Math.min(best, distanceToSegment(point, a, b));
    }
  }
  const only = vertices[0];
  if (vertices.length === 1 && only) {
    best = Math.hypot(point.x - only.x, point.y - only.y);
  }
  return best;
}

export function objectBounds(object: CanvasObject): Rect {
  switch (object.type) {
    case 'rectangle':
    case 'ellipse':
      return { x: object.x, y: object.y, width: object.width, height: object.height };
    case 'pen':
      return boundsOf(
        object.points.map((point) => ({ x: object.x + point.x, y: object.y + point.y })),
        object.strokeWidth / 2,
      );
    case 'line':
    case 'arrow':
      return boundsOf(
        [
          { x: object.x, y: object.y },
          { x: object.x + object.dx, y: object.y + object.dy },
        ],
        object.strokeWidth / 2,
      );
    case 'text': {
      const lines = object.text.split('\n');
      const longest = Math.max(1, ...lines.map((line) => line.length));
      return {
        x: object.x,
        y: object.y,
        width: longest * object.fontSize * TEXT_CHAR_WIDTH,
        height: lines.length * object.fontSize * TEXT_LINE_HEIGHT,
      };
    }
  }
}

// `tolerance` is in world units; callers convert screen pixels with worldLength().
export function hitTest(object: CanvasObject, point: Point, tolerance: number): boolean {
  switch (object.type) {
    case 'pen': {
      const vertices = object.points.map((p) => ({ x: object.x + p.x, y: object.y + p.y }));
      return distanceToPolyline(point, vertices) <= tolerance + object.strokeWidth / 2;
    }
    case 'line':
    case 'arrow': {
      const start = { x: object.x, y: object.y };
      const end = { x: object.x + object.dx, y: object.y + object.dy };
      return distanceToSegment(point, start, end) <= tolerance + object.strokeWidth / 2;
    }
    case 'rectangle': {
      const { x, y, width, height } = object;
      if (object.fill) {
        return containsPoint(expandRect(objectBounds(object), tolerance), point);
      }
      const corners = [
        { x, y },
        { x: x + width, y },
        { x: x + width, y: y + height },
        { x, y: y + height },
        { x, y },
      ];
      return distanceToPolyline(point, corners) <= tolerance + object.strokeWidth / 2;
    }
    case 'ellipse': {
      const radiusX = object.width / 2;
      const radiusY = object.height / 2;
      if (radiusX <= 0 || radiusY <= 0) {
        return containsPoint(expandRect(objectBounds(object), tolerance), point);
      }
      const centerX = object.x + radiusX;
      const centerY = object.y + radiusY;
      const normalized = Math.hypot((point.x - centerX) / radiusX, (point.y - centerY) / radiusY);
      // Scale the tolerance so it is a distance near the boundary, not a normalized value.
      const slack = (tolerance + object.strokeWidth / 2) / Math.min(radiusX, radiusY);
      return object.fill ? normalized <= 1 + slack : Math.abs(normalized - 1) <= slack;
    }
    case 'text':
      return containsPoint(expandRect(objectBounds(object), tolerance), point);
  }
}

// Returns the topmost object under the point. Later objects are drawn on top.
export function pickObject(
  objects: readonly CanvasObject[],
  point: Point,
  tolerance: number,
): CanvasObject | undefined {
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const object = objects[index];
    if (object && hitTest(object, point, tolerance)) {
      return object;
    }
  }
  return undefined;
}

export function objectsInRect(objects: readonly CanvasObject[], rect: Rect): CanvasObject[] {
  return objects.filter((object) => rectsIntersect(objectBounds(object), rect));
}
