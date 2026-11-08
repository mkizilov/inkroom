import type { CanvasObject, Region } from '@inkroom/shared';
import { objectBounds, objectsInRect, type Rect } from '../canvas/geometry';

// What an export covers: the whole board, the selected objects, or a region in board units.
export type ExportScope = 'board' | 'selection' | 'region';

// Space left around the objects of a whole-board or selection export, so strokes at the edge are kept.
export const EXPORT_MARGIN = 20;

// The area of a board with nothing on it.
export const EMPTY_BOARD_REGION: Region = { x: 0, y: 0, width: 800, height: 600 };

export interface ExportSelection {
  // The objects to export, back to front.
  objects: CanvasObject[];
  // The area the picture shows. For an SVG it is the viewBox, so coordinates are the board's own.
  viewport: Region;
  // The area recorded in a JSON export. Null for the whole board.
  recordedRegion: Region | null;
}

// The smallest rectangle that holds every rectangle given, or null when there are none.
export function unionOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) {
    return null;
  }
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function withMargin(rect: Rect): Region {
  return {
    x: rect.x - EXPORT_MARGIN,
    y: rect.y - EXPORT_MARGIN,
    width: rect.width + 2 * EXPORT_MARGIN,
    height: rect.height + 2 * EXPORT_MARGIN,
  };
}

function boundsOrEmpty(objects: readonly CanvasObject[]): Region {
  const bounds = unionOf(objects.map((object) => objectBounds(object)));
  return bounds ? withMargin(bounds) : EMPTY_BOARD_REGION;
}

// The objects a scope covers, and the area they are shown in. A region export keeps every object that
// touches the region, whole, so an object at the edge is not cut in the file.
export function selectForExport(
  scope: ExportScope,
  objects: readonly CanvasObject[],
  selectedIds: readonly string[],
  region: Region,
): ExportSelection {
  if (scope === 'region') {
    return { objects: objectsInRect(objects, region), viewport: region, recordedRegion: region };
  }
  if (scope === 'selection') {
    const chosen = new Set(selectedIds);
    const selected = objects.filter((object) => chosen.has(object.id));
    const viewport = boundsOrEmpty(selected);
    return { objects: selected, viewport, recordedRegion: viewport };
  }
  return { objects: [...objects], viewport: boundsOrEmpty(objects), recordedRegion: null };
}
