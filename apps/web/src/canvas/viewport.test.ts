import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  panBy,
  pinchSample,
  pinchViewport,
  screenToWorld,
  wheelViewport,
  worldLength,
  worldToScreen,
  zoomAt,
  type Viewport,
} from './viewport';

const views: Viewport[] = [
  { scale: 1, offsetX: 0, offsetY: 0 },
  { scale: 0.25, offsetX: 180, offsetY: -40 },
  { scale: 2, offsetX: -300.5, offsetY: 75 },
  { scale: 7.5, offsetX: 12, offsetY: 9 },
];

describe('screen and world coordinates', () => {
  it('converts a screen point to world space and back at every zoom level', () => {
    for (const viewport of views) {
      const screen = { x: 412.5, y: -88 };
      const world = screenToWorld(screen, viewport);
      const back = worldToScreen(world, viewport);
      expect(back.x).toBeCloseTo(screen.x, 9);
      expect(back.y).toBeCloseTo(screen.y, 9);
    }
  });

  it('maps the origin of the screen to the world point implied by the offset', () => {
    const viewport = { scale: 2, offsetX: 100, offsetY: 50 };
    expect(screenToWorld({ x: 100, y: 50 }, viewport)).toEqual({ x: 0, y: 0 });
    expect(screenToWorld({ x: 120, y: 70 }, viewport)).toEqual({ x: 10, y: 10 });
  });

  it('keeps a world object under the same screen pixel after a pan', () => {
    const viewport = views[2] as Viewport;
    const world = { x: 40, y: 60 };
    const before = worldToScreen(world, viewport);
    const panned = panBy(viewport, 25, -10);
    const after = worldToScreen(world, panned);
    expect(after.x - before.x).toBe(25);
    expect(after.y - before.y).toBe(-10);
  });

  it('converts screen pixels to world units at the current zoom', () => {
    expect(worldLength(6, { scale: 2, offsetX: 0, offsetY: 0 })).toBe(3);
    expect(worldLength(6, { scale: 0.5, offsetX: 0, offsetY: 0 })).toBe(12);
  });
});

describe('zoomAt', () => {
  it('keeps the world point under the anchor fixed', () => {
    for (const viewport of views) {
      const anchor = { x: 333, y: 210 };
      const worldBefore = screenToWorld(anchor, viewport);
      const zoomed = zoomAt(viewport, anchor, viewport.scale * 1.7);
      const worldAfter = screenToWorld(anchor, zoomed);
      expect(worldAfter.x).toBeCloseTo(worldBefore.x, 9);
      expect(worldAfter.y).toBeCloseTo(worldBefore.y, 9);
    }
  });

  it('clamps the scale to the supported range', () => {
    const viewport = views[0] as Viewport;
    expect(zoomAt(viewport, { x: 0, y: 0 }, 1000).scale).toBe(MAX_SCALE);
    expect(zoomAt(viewport, { x: 0, y: 0 }, 0.00001).scale).toBe(MIN_SCALE);
    expect(clampScale(3)).toBe(3);
  });
});

describe('wheel input', () => {
  const anchor = { x: 200, y: 150 };

  it('pans with plain wheel and trackpad scrolling, in the opposite direction to the delta', () => {
    const viewport = views[0] as Viewport;
    const next = wheelViewport(viewport, anchor, { deltaX: 0, deltaY: 30, zoom: false });
    expect(next).toEqual({ scale: 1, offsetX: 0, offsetY: -30 });
  });

  it('zooms in around the pointer for negative deltas with Ctrl or Meta', () => {
    const viewport = views[0] as Viewport;
    const next = wheelViewport(viewport, anchor, { deltaX: 0, deltaY: -20, zoom: true });
    expect(next.scale).toBeGreaterThan(1);
    expect(screenToWorld(anchor, next).x).toBeCloseTo(screenToWorld(anchor, viewport).x, 9);
    expect(screenToWorld(anchor, next).y).toBeCloseTo(screenToWorld(anchor, viewport).y, 9);
  });

  it('zooms out for positive deltas', () => {
    const viewport = views[0] as Viewport;
    const next = wheelViewport(viewport, anchor, { deltaX: 0, deltaY: 20, zoom: true });
    expect(next.scale).toBeLessThan(1);
  });
});

describe('pinch gestures', () => {
  it('scales by the change in finger distance', () => {
    const start = {
      viewport: { scale: 1, offsetX: 0, offsetY: 0 },
      ...pinchSample({ x: 100, y: 100 }, { x: 200, y: 100 }),
    };
    const next = pinchViewport(start, pinchSample({ x: 50, y: 100 }, { x: 250, y: 100 }));
    expect(next.scale).toBeCloseTo(2, 9);
  });

  it('keeps the world point under the starting midpoint under the current midpoint', () => {
    const start = {
      viewport: views[2] as Viewport,
      ...pinchSample({ x: 300, y: 220 }, { x: 340, y: 260 }),
    };
    const worldMid = screenToWorld(start.midpoint, start.viewport);
    const current = pinchSample({ x: 410, y: 180 }, { x: 470, y: 230 });

    const next = pinchViewport(start, current);

    const screenMid = worldToScreen(worldMid, next);
    expect(screenMid.x).toBeCloseTo(current.midpoint.x, 9);
    expect(screenMid.y).toBeCloseTo(current.midpoint.y, 9);
  });

  it('keeps the viewport when the fingers start at the same point', () => {
    const viewport = views[1] as Viewport;
    const start = { viewport, ...pinchSample({ x: 5, y: 5 }, { x: 5, y: 5 }) };
    expect(pinchViewport(start, pinchSample({ x: 0, y: 0 }, { x: 40, y: 0 }))).toBe(viewport);
  });
});
