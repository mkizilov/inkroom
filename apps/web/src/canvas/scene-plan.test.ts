import { describe, expect, it } from 'vitest';
import type { CanvasObject } from '@inkroom/shared';
import { objectBounds, rectsIntersect, type Rect } from './geometry';
import { CULL_MARGIN, planScene, visibleWorldRect } from './scene-plan';
import type { Viewport } from './viewport';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };

function rectangle(n: number, x: number, y: number): CanvasObject {
  return {
    id: id(n),
    type: 'rectangle',
    x,
    y,
    width: 10,
    height: 10,
    stroke: '#000000',
    strokeWidth: 2,
  };
}

function text(n: number, x: number, y: number, value: string, fontSize: number): CanvasObject {
  return {
    id: id(n),
    type: 'text',
    x,
    y,
    text: value,
    stroke: '#000000',
    strokeWidth: 1,
    fontSize,
  };
}

// The part of the board a viewport shows, in board units, without the margin.
function shownArea(viewport: Viewport, width: number, height: number): Rect {
  return {
    x: -viewport.offsetX / viewport.scale,
    y: -viewport.offsetY / viewport.scale,
    width: width / viewport.scale,
    height: height / viewport.scale,
  };
}

describe('visibleWorldRect', () => {
  it('is the view in board units, grown by the margin', () => {
    expect(visibleWorldRect(identity, 800, 600)).toEqual({
      x: -CULL_MARGIN,
      y: -CULL_MARGIN,
      width: 800 + 2 * CULL_MARGIN,
      height: 600 + 2 * CULL_MARGIN,
    });
  });

  it('follows zoom and pan', () => {
    const zoomed: Viewport = { scale: 2, offsetX: -400, offsetY: 0 };

    expect(visibleWorldRect(zoomed, 800, 600)).toEqual({
      x: 200 - CULL_MARGIN,
      y: -CULL_MARGIN,
      width: 400 + 2 * CULL_MARGIN,
      height: 300 + 2 * CULL_MARGIN,
    });
  });
});

describe('planScene', () => {
  it('keeps the objects that touch the view and drops the ones far outside it', () => {
    const objects = [rectangle(1, 100, 100), rectangle(2, 5000, 5000), rectangle(3, -40, -40)];

    const plan = planScene(objects, [], identity, 800, 600, null);

    expect(plan.visible.map((object) => object.id)).toEqual([id(1), id(3)]);
  });

  it('keeps the stacking order of the objects it keeps', () => {
    const objects = [rectangle(1, 0, 0), rectangle(2, 5, 5), rectangle(3, 10, 10)];

    const plan = planScene(objects, [], identity, 800, 600, null);

    expect(plan.visible.map((object) => object.id)).toEqual([id(1), id(2), id(3)]);
  });

  it('never drops an object that is on screen, at any zoom or pan', () => {
    const objects: CanvasObject[] = [];
    for (let n = 1; n <= 400; n += 1) {
      objects.push(rectangle(n, ((n * 137) % 2000) - 500, ((n * 89) % 1500) - 300));
    }
    const viewports: Viewport[] = [
      identity,
      { scale: 0.25, offsetX: -300, offsetY: 120 },
      { scale: 3, offsetX: -2400, offsetY: -900 },
    ];
    for (const viewport of viewports) {
      const plan = planScene(objects, [], viewport, 800, 600, null);
      const shown = new Set(plan.visible.map((object) => object.id));
      for (const object of objects) {
        if (rectsIntersect(objectBounds(object), shownArea(viewport, 800, 600))) {
          expect(shown.has(object.id)).toBe(true);
        }
      }
    }
  });

  it('keeps long text at the edge of the view', () => {
    // Selection estimates 40 characters at 0.6 em, so this text ends at x = -140, left of the view
    // and its margin. Drawn with the browser's font it can run further, so culling uses a full em per
    // character and this text reaches the view.
    const long = text(1, -1100, 0, 'x'.repeat(40), 40);

    const plan = planScene([long], [], identity, 800, 600, null);

    expect(plan.visible).toEqual([long]);
  });

  it('leaves the text being edited out of the drawing, but keeps its selection outline', () => {
    const editing = text(1, 10, 10, 'draft', 20);
    const other = rectangle(2, 20, 20);

    const plan = planScene([editing, other], [id(1)], identity, 800, 600, id(1));

    expect(plan.visible.map((object) => object.id)).toEqual([id(2)]);
    expect(plan.selectedVisible.map((object) => object.id)).toEqual([id(1)]);
  });

  it('outlines only the selected objects that can be seen', () => {
    const near = rectangle(1, 10, 10);
    const far = rectangle(2, 9000, 9000);

    const plan = planScene([near, far], [id(1), id(2)], identity, 800, 600, null);

    expect(plan.selectedVisible.map((object) => object.id)).toEqual([id(1)]);
  });
});
