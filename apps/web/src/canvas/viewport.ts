import type { Point } from '@inkroom/shared';

// screen = world * scale + offset. Pointer input is converted to world space once, here, and the
// rest of the editor works in world units.
export interface Viewport {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;
export const INITIAL_VIEWPORT: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };

// Controls how quickly wheel deltas turn into zoom. Pinch gestures in browsers arrive as wheel
// events with ctrlKey set and small deltaY values.
const WHEEL_ZOOM_SENSITIVITY = 0.01;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function screenToWorld(point: Point, viewport: Viewport): Point {
  return {
    x: (point.x - viewport.offsetX) / viewport.scale,
    y: (point.y - viewport.offsetY) / viewport.scale,
  };
}

export function worldToScreen(point: Point, viewport: Viewport): Point {
  return {
    x: point.x * viewport.scale + viewport.offsetX,
    y: point.y * viewport.scale + viewport.offsetY,
  };
}

// Converts a length in screen pixels to world units at the current zoom, so hit slop and
// minimum spacing feel the same at every zoom level.
export function worldLength(pixels: number, viewport: Viewport): number {
  return pixels / viewport.scale;
}

export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return { ...viewport, offsetX: viewport.offsetX + dx, offsetY: viewport.offsetY + dy };
}

// Changes the scale while keeping the world point under `anchor` at the same screen position.
export function zoomAt(viewport: Viewport, anchor: Point, scale: number): Viewport {
  const next = clampScale(scale);
  const world = screenToWorld(anchor, viewport);
  return {
    scale: next,
    offsetX: anchor.x - world.x * next,
    offsetY: anchor.y - world.y * next,
  };
}

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  zoom: boolean;
}

// Ctrl or Meta with the wheel (or a trackpad pinch) zooms around the pointer. Other wheel input
// pans, which matches two-finger trackpad scrolling.
export function wheelViewport(viewport: Viewport, anchor: Point, input: WheelInput): Viewport {
  if (input.zoom) {
    const factor = Math.exp(-input.deltaY * WHEEL_ZOOM_SENSITIVITY);
    return zoomAt(viewport, anchor, viewport.scale * factor);
  }
  return panBy(viewport, -input.deltaX, -input.deltaY);
}

export interface PinchSample {
  midpoint: Point;
  distance: number;
}

export interface PinchStart extends PinchSample {
  viewport: Viewport;
}

export function pinchSample(a: Point, b: Point): PinchSample {
  return {
    midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    distance: Math.hypot(a.x - b.x, a.y - b.y),
  };
}

// Two-finger gesture: the scale follows the change in finger distance, and the world point that
// was under the starting midpoint stays under the current midpoint. This handles pinch and pan
// in one calculation.
export function pinchViewport(start: PinchStart, current: PinchSample): Viewport {
  if (start.distance <= 0) {
    return start.viewport;
  }
  const scale = clampScale(start.viewport.scale * (current.distance / start.distance));
  const world = screenToWorld(start.midpoint, start.viewport);
  return {
    scale,
    offsetX: current.midpoint.x - world.x * scale,
    offsetY: current.midpoint.y - world.y * scale,
  };
}
