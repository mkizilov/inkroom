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
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
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

// The extent of points, each shifted by an offset. Reads every point once and allocates nothing: a
// freehand stroke can have thousands of points, and this runs on every render and every marquee move.
function boundsOf(points: readonly Point[], offsetX = 0, offsetY = 0): Rect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const x = offsetX + point.x;
    const y = offsetY + point.y;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
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

function absolutePoints(object: { x: number; y: number; points: Point[] }): Point[] {
  return object.points.map((point) => ({ x: object.x + point.x, y: object.y + point.y }));
}

// Extents are read on every render and on every marquee move, and objects are never changed in place
// (an edit makes a new object). So each object's extent is computed once and kept, frozen, so a
// mistaken write to it fails instead of corrupting later reads.
const geometricCache = new WeakMap<CanvasObject, Rect>();

// The object's own extent, without stroke padding. Selection boxes and resizing use this, so a
// box resized to 100 by 60 gives an object whose geometry is exactly 100 by 60.
export function geometricBounds(object: CanvasObject): Rect {
  const cached = geometricCache.get(object);
  if (cached) {
    return cached;
  }
  const bounds = Object.freeze(computeGeometricBounds(object));
  geometricCache.set(object, bounds);
  return bounds;
}

function computeGeometricBounds(object: CanvasObject): Rect {
  switch (object.type) {
    case 'rectangle':
    case 'ellipse':
      return { x: object.x, y: object.y, width: object.width, height: object.height };
    case 'pen':
      return boundsOf(object.points, object.x, object.y);
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

// Bounds used for hit testing. Strokes are padded by half their width.
export function objectBounds(object: CanvasObject): Rect {
  const bounds = geometricBounds(object);
  if (object.type === 'pen' || object.type === 'line' || object.type === 'arrow') {
    return expandRect(bounds, object.strokeWidth / 2);
  }
  return bounds;
}

// `tolerance` is in world units; callers convert screen pixels with worldLength().
export function hitTest(object: CanvasObject, point: Point, tolerance: number): boolean {
  switch (object.type) {
    case 'pen': {
      const reach = tolerance + object.strokeWidth / 2;
      // A stroke has no point farther than `reach` outside its bounds, so most strokes are rejected
      // here without measuring each segment.
      if (!containsPoint(expandRect(geometricBounds(object), reach), point)) {
        return false;
      }
      return distanceToPolyline(point, absolutePoints(object)) <= reach;
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
        return containsPoint(expandRect(geometricBounds(object), tolerance), point);
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
        return containsPoint(expandRect(geometricBounds(object), tolerance), point);
      }
      const centerX = object.x + radiusX;
      const centerY = object.y + radiusY;
      const normalized = Math.hypot((point.x - centerX) / radiusX, (point.y - centerY) / radiusY);
      // Scale the tolerance so it is a distance near the boundary, not a normalized value.
      const slack = (tolerance + object.strokeWidth / 2) / Math.min(radiusX, radiusY);
      return object.fill ? normalized <= 1 + slack : Math.abs(normalized - 1) <= slack;
    }
    case 'text':
      return containsPoint(expandRect(geometricBounds(object), tolerance), point);
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

// Arrowheads are drawn the same way on the canvas and in exports: a filled triangle this long and
// this wide, with its tip at the end point.
const ARROW_HEAD = 10;

// The three corners of an arrowhead: the tip, then the two corners of its base. Null for an arrow with
// no length.
export function arrowHeadCorners(start: Point, end: Point): [Point, Point, Point] | null {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length === 0) {
    return null;
  }
  const ux = (end.x - start.x) / length;
  const uy = (end.y - start.y) / length;
  const baseX = end.x - ux * ARROW_HEAD;
  const baseY = end.y - uy * ARROW_HEAD;
  const sideX = (-uy * ARROW_HEAD) / 2;
  const sideY = (ux * ARROW_HEAD) / 2;
  return [
    { x: end.x, y: end.y },
    { x: baseX + sideX, y: baseY + sideY },
    { x: baseX - sideX, y: baseY - sideY },
  ];
}

// Whether the drawn part of an object reaches the rectangle, edges included. Lines and pens are drawn
// with round ends, so their stroke reaches every point within half its width of the path. An arrow's
// shaft works the same way, and its head is a filled triangle. Other objects are judged by their box,
// which is their outline's extent.
export function touchesRect(object: CanvasObject, rect: Rect): boolean {
  if (object.type !== 'line' && object.type !== 'arrow' && object.type !== 'pen') {
    return rectsIntersect(objectBounds(object), rect);
  }
  const halfWidth = object.strokeWidth / 2;
  const path =
    object.type === 'pen'
      ? absolutePoints(object)
      : [
          { x: object.x, y: object.y },
          { x: object.x + object.dx, y: object.y + object.dy },
        ];
  for (let index = 0; index + 1 < path.length; index += 1) {
    const from = path[index];
    const to = path[index + 1];
    if (from && to && segmentRectDistance(from, to, rect) <= halfWidth) {
      return true;
    }
  }
  if (object.type !== 'arrow') {
    return false;
  }
  const head = arrowHeadCorners(
    { x: object.x, y: object.y },
    { x: object.x + object.dx, y: object.y + object.dy },
  );
  return head !== null && triangleMeetsRect(head, rect);
}

function rectCorners(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

// Whether a segment meets a closed rectangle. Liang-Barsky clipping, with the boundaries included.
function segmentMeetsRect(a: Point, b: Point, rect: Rect): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let enter = 0;
  let leave = 1;
  const clips: Array<[number, number]> = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.width - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.height - a.y],
  ];
  for (const [p, q] of clips) {
    if (p === 0) {
      if (q < 0) {
        return false;
      }
    } else if (p < 0) {
      const t = q / p;
      if (t > leave) {
        return false;
      }
      enter = Math.max(enter, t);
    } else {
      const t = q / p;
      if (t < enter) {
        return false;
      }
      leave = Math.min(leave, t);
    }
  }
  return true;
}

function pointRectDistance(point: Point, rect: Rect): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

// The closest distance between a segment and a rectangle, zero when they meet. When they are apart,
// the closest pair has one point at an end of the segment or at a corner of the rectangle.
function segmentRectDistance(a: Point, b: Point, rect: Rect): number {
  if (segmentMeetsRect(a, b, rect)) {
    return 0;
  }
  return Math.min(
    pointRectDistance(a, rect),
    pointRectDistance(b, rect),
    ...rectCorners(rect).map((corner) => distanceToSegment(corner, a, b)),
  );
}

// Whether a filled triangle meets the rectangle: one of its edges does, or a corner of the rectangle
// lies inside it.
function triangleMeetsRect(corners: readonly [Point, Point, Point], rect: Rect): boolean {
  const [a, b, c] = corners;
  return (
    segmentMeetsRect(a, b, rect) ||
    segmentMeetsRect(b, c, rect) ||
    segmentMeetsRect(c, a, rect) ||
    rectCorners(rect).some((corner) => insideTriangle(corner, a, b, c))
  );
}

function insideTriangle(point: Point, a: Point, b: Point, c: Point): boolean {
  const side = (from: Point, to: Point) =>
    (to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x);
  const sides = [side(a, b), side(b, c), side(c, a)];
  return !(sides.some((value) => value < 0) && sides.some((value) => value > 0));
}
