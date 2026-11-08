import type { CanvasObject } from '@inkroom/shared';
import { objectBounds, rectsIntersect, type Rect } from './geometry';
import { screenToWorld, type Viewport } from './viewport';

// Objects further than this outside the view are not drawn. A stroke reaches half its width (at most
// 32) past its bounds, and an arrowhead stays within that, so the margin keeps every drawn part whole.
export const CULL_MARGIN = 64;

// Text is drawn with the browser's own font, which can be wider than the estimate that selection uses.
// For culling a generous size is used instead, so text at the edge of the view is never dropped.
const CULLING_CHAR_WIDTH = 1;
const CULLING_LINE_HEIGHT = 1.5;

export interface ScenePlan {
  // The objects that can be seen, back to front. The text being edited is left out, since it is drawn
  // by the editor's own text box.
  visible: CanvasObject[];
  // The selected objects that can be seen, back to front. Each one gets a selection outline.
  selectedVisible: CanvasObject[];
}

// The view in board units, grown by the margin.
export function visibleWorldRect(viewport: Viewport, width: number, height: number): Rect {
  const topLeft = screenToWorld({ x: 0, y: 0 }, viewport);
  const bottomRight = screenToWorld({ x: width, y: height }, viewport);
  return {
    x: topLeft.x - CULL_MARGIN,
    y: topLeft.y - CULL_MARGIN,
    width: bottomRight.x - topLeft.x + 2 * CULL_MARGIN,
    height: bottomRight.y - topLeft.y + 2 * CULL_MARGIN,
  };
}

const cullingCache = new WeakMap<CanvasObject, Rect>();

// The area a text object may cover when it is drawn. Other objects use their bounds, which already
// include their strokes.
function cullingBounds(object: CanvasObject): Rect {
  if (object.type !== 'text') {
    return objectBounds(object);
  }
  const cached = cullingCache.get(object);
  if (cached) {
    return cached;
  }
  const lines = object.text.split('\n');
  const longest = Math.max(1, ...lines.map((line) => line.length));
  const bounds = Object.freeze({
    x: object.x,
    y: object.y,
    width: longest * object.fontSize * CULLING_CHAR_WIDTH,
    height: lines.length * object.fontSize * CULLING_LINE_HEIGHT,
  });
  cullingCache.set(object, bounds);
  return bounds;
}

// Decides what the canvas needs to draw. Objects outside the view are left out, so the number of
// drawn nodes follows what is on screen rather than the size of the board. Selection is looked up
// through a set, so it costs the same per object whatever the number of selected objects.
export function planScene(
  objects: readonly CanvasObject[],
  selectedIds: readonly string[],
  viewport: Viewport,
  width: number,
  height: number,
  hiddenTextId: string | null,
): ScenePlan {
  const window = visibleWorldRect(viewport, width, height);
  const selected = new Set(selectedIds);
  const visible: CanvasObject[] = [];
  const selectedVisible: CanvasObject[] = [];
  for (const object of objects) {
    if (!rectsIntersect(cullingBounds(object), window)) {
      continue;
    }
    if (selected.has(object.id)) {
      selectedVisible.push(object);
    }
    if (object.id !== hiddenTextId) {
      visible.push(object);
    }
  }
  return { visible, selectedVisible };
}
