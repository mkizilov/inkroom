import type { CanvasObject, Point } from '@inkroom/shared';

// The bounds and selection code as it was before the performance work (commit 67ecc26), copied
// unchanged. The benchmarks compare the live code with these copies, so every run has the same
// baseline. Do not change these functions: they exist to measure the old behaviour.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const TEXT_CHAR_WIDTH = 0.6;
const TEXT_LINE_HEIGHT = 1.2;

function rectsIntersect(a: Box, b: Box): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

function expandRect(rect: Box, amount: number): Box {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

function boundsOf(points: Point[]): Box {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

function absolutePoints(object: { x: number; y: number; points: Point[] }): Point[] {
  return object.points.map((point) => ({ x: object.x + point.x, y: object.y + point.y }));
}

export function referenceGeometricBounds(object: CanvasObject): Box {
  switch (object.type) {
    case 'rectangle':
    case 'ellipse':
      return { x: object.x, y: object.y, width: object.width, height: object.height };
    case 'pen':
      return boundsOf(absolutePoints(object));
    case 'line':
    case 'arrow':
      return boundsOf([
        { x: object.x, y: object.y },
        { x: object.x + object.dx, y: object.y + object.dy },
      ]);
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

export function referenceObjectBounds(object: CanvasObject): Box {
  const bounds = referenceGeometricBounds(object);
  if (object.type === 'pen' || object.type === 'line' || object.type === 'arrow') {
    return expandRect(bounds, object.strokeWidth / 2);
  }
  return bounds;
}

export function referenceObjectsInRect(
  objects: readonly CanvasObject[],
  rect: Box,
): CanvasObject[] {
  return objects.filter((object) => rectsIntersect(referenceObjectBounds(object), rect));
}

// The selection lookup as the scene used it: a linear search of the selected ids for every object.
export function referenceSelectedObjects(
  objects: readonly CanvasObject[],
  selectedIds: readonly string[],
): CanvasObject[] {
  return objects.filter((object) => selectedIds.includes(object.id));
}

function referenceContainsPoint(rect: Box, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function referenceDistanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - a.x, point.y - a.y);
  }
  const t = Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function referenceDistanceToPolyline(point: Point, vertices: Point[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < vertices.length - 1; index += 1) {
    const a = vertices[index];
    const b = vertices[index + 1];
    if (a && b) {
      best = Math.min(best, referenceDistanceToSegment(point, a, b));
    }
  }
  const only = vertices[0];
  if (vertices.length === 1 && only) {
    best = Math.hypot(point.x - only.x, point.y - only.y);
  }
  return best;
}

// Hit testing as it was before the performance work: every stroke is measured segment by segment.
export function referenceHitTest(object: CanvasObject, point: Point, tolerance: number): boolean {
  switch (object.type) {
    case 'pen': {
      const reach = tolerance + object.strokeWidth / 2;
      return referenceDistanceToPolyline(point, absolutePoints(object)) <= reach;
    }
    case 'line':
    case 'arrow': {
      const start = { x: object.x, y: object.y };
      const end = { x: object.x + object.dx, y: object.y + object.dy };
      return referenceDistanceToSegment(point, start, end) <= tolerance + object.strokeWidth / 2;
    }
    case 'rectangle': {
      const { x, y, width, height } = object;
      if (object.fill) {
        return referenceContainsPoint(
          expandRect(referenceGeometricBounds(object), tolerance),
          point,
        );
      }
      const corners = [
        { x, y },
        { x: x + width, y },
        { x: x + width, y: y + height },
        { x, y: y + height },
        { x, y },
      ];
      return referenceDistanceToPolyline(point, corners) <= tolerance + object.strokeWidth / 2;
    }
    case 'ellipse': {
      const radiusX = object.width / 2;
      const radiusY = object.height / 2;
      if (radiusX <= 0 || radiusY <= 0) {
        return referenceContainsPoint(
          expandRect(referenceGeometricBounds(object), tolerance),
          point,
        );
      }
      const centerX = object.x + radiusX;
      const centerY = object.y + radiusY;
      const normalized = Math.hypot((point.x - centerX) / radiusX, (point.y - centerY) / radiusY);
      const slack = (tolerance + object.strokeWidth / 2) / Math.min(radiusX, radiusY);
      return object.fill ? normalized <= 1 + slack : Math.abs(normalized - 1) <= slack;
    }
    case 'text':
      return referenceContainsPoint(
        expandRect(referenceGeometricBounds(object), tolerance),
        point,
      );
  }
}

export function referencePickObject(
  objects: readonly CanvasObject[],
  point: Point,
  tolerance: number,
): CanvasObject | undefined {
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const object = objects[index];
    if (object && referenceHitTest(object, point, tolerance)) {
      return object;
    }
  }
  return undefined;
}
