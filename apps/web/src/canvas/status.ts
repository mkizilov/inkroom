import type { CanvasObject } from '@inkroom/shared';
import { selectionBounds } from './transform';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

// Text that screen readers announce after each change, and that tests can check.
export function describeCanvas(
  objects: readonly CanvasObject[],
  selectedIds: readonly string[],
): string {
  const count = plural(objects.length, 'object');
  if (selectedIds.length === 0) {
    return count;
  }
  const selected = `${selectedIds.length} selected`;
  const box = selectionBounds(objects, selectedIds);
  if (!box) {
    return `${count} · ${selected}`;
  }
  const size = `${Math.round(box.width)} × ${Math.round(box.height)}`;
  const at = `at ${Math.round(box.x)}, ${Math.round(box.y)}`;
  return `${count} · ${selected} · ${size} ${at}`;
}
