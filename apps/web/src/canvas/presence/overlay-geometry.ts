import type { Point } from '@inkroom/shared';
import type { Rect } from '../geometry';
import { worldToScreen, type Viewport } from '../viewport';

export interface ScreenSize {
  width: number;
  height: number;
}

export interface CursorPlacement {
  x: number;
  y: number;
  onScreen: boolean;
}

// Where a remote cursor is drawn in this client's view. A cursor inside the view is drawn where it
// is. A cursor outside it is pinned to the nearest edge, inset by a margin, so the viewer can see
// which way to pan to find the participant. This is how clients looking at different regions of the
// board still see each other.
export function placeCursor(point: Point, size: ScreenSize, margin = 16): CursorPlacement {
  const onScreen = point.x >= 0 && point.y >= 0 && point.x <= size.width && point.y <= size.height;
  if (onScreen) {
    return { x: point.x, y: point.y, onScreen: true };
  }
  return {
    x: clamp(point.x, margin, size.width - margin),
    y: clamp(point.y, margin, size.height - margin),
    onScreen: false,
  };
}

// A world-space box as a box in this client's screen coordinates.
export function screenBoxFor(bounds: Rect, viewport: Viewport): Rect {
  const origin = worldToScreen({ x: bounds.x, y: bounds.y }, viewport);
  return {
    x: origin.x,
    y: origin.y,
    width: bounds.width * viewport.scale,
    height: bounds.height * viewport.scale,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
