// Benchmarks for the pure canvas code: object bounds, the scene plan (selection lookup and viewport
// culling), marquee selection and picking. Run with `pnpm --filter @inkroom/web bench:geometry`, or
// see docs/performance.md.
//
// Every measurement runs the same operation on the frozen reference (bench/reference.ts, the code as
// it was at commit 67ecc26) and on the live code. Variants are interleaved round by round, so neither
// one always runs first. Before timing, the runner checks that the live results equal the reference
// results, and it exits with code 1 if they do not. Results are medians over measured rounds.

import { writeFileSync } from 'node:fs';
import os from 'node:os';
import type { CanvasObject, Point } from '@inkroom/shared';
import { objectBounds, objectsInRect, pickObject, type Rect } from '../src/canvas/geometry.ts';
import { planScene } from '../src/canvas/scene-plan.ts';
import type { Viewport } from '../src/canvas/viewport.ts';
import { boardSide, generateBoard } from './fixtures.ts';
import {
  referenceObjectBounds,
  referenceObjectsInRect,
  referencePickObject,
  referenceSelectedObjects,
} from './reference.ts';

const WARMUP_ROUNDS = 3;
const MEASURED_ROUNDS = 21;
const SCREEN = { width: 1280, height: 800 };

// Keeps results alive, so the engine cannot drop the work being timed.
let sink = 0;

interface Timing {
  medianMs: number;
  p95Ms: number;
}

// One round: prepares its input (not timed), then times the work and returns the elapsed time.
type Case = () => number;

function timedCase<T>(prepare: () => T, run: (input: T) => number): Case {
  return () => {
    const input = prepare();
    const start = performance.now();
    sink += run(input);
    return performance.now() - start;
  };
}

function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

function measureRounds(cases: Record<string, Case>): Record<string, Timing> {
  const names = Object.keys(cases);
  const samples = new Map<string, number[]>(names.map((name) => [name, []]));
  for (let round = 0; round < WARMUP_ROUNDS + MEASURED_ROUNDS; round += 1) {
    for (let offset = 0; offset < names.length; offset += 1) {
      const name = names[(round + offset) % names.length] ?? '';
      const elapsed = cases[name]?.() ?? 0;
      if (round >= WARMUP_ROUNDS) {
        samples.get(name)?.push(elapsed);
      }
    }
  }
  const summary: Record<string, Timing> = {};
  for (const name of names) {
    const sorted = [...(samples.get(name) ?? [])].sort((a, b) => a - b);
    summary[name] = { medianMs: quantile(sorted, 0.5), p95Ms: quantile(sorted, 0.95) };
  }
  return summary;
}

// New object identities with the same contents: what a fresh snapshot of the board produces.
function fresh(objects: readonly CanvasObject[]): CanvasObject[] {
  return objects.map((object) => ({ ...object }));
}

function marqueeRects(count: number, side: number): Rect[] {
  return Array.from({ length: count }, (_, step) => ({
    x: (step / count) * side * 0.5,
    y: side * 0.25,
    width: side * 0.2,
    height: side * 0.2,
  }));
}

// Points spread over the board in a fixed pattern, so each run tests the same places.
function randomPicks(side: number, count: number): Point[] {
  return Array.from({ length: count }, (_, step) => ({
    x: (((step * 97) % 1000) / 1000) * side,
    y: (((step * 389) % 1000) / 1000) * side,
  }));
}

// Points that test each hit path: the centre of an object, and points just inside and just outside
// the edge of a freehand stroke.
function pickTargets(objects: readonly CanvasObject[]): Point[] {
  const targets: Point[] = [];
  for (const object of objects) {
    const bounds = objectBounds(object);
    targets.push({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    if (object.type === 'pen') {
      for (const point of object.points.slice(0, 4)) {
        targets.push({ x: object.x + point.x + 1, y: object.y + point.y + 1 });
        targets.push({ x: object.x + point.x + 6, y: object.y + point.y });
      }
    }
  }
  return targets;
}

// A viewport whose centre shows the given world point.
function viewportShowing(centre: Point, scale: number): Viewport {
  return {
    scale,
    offsetX: SCREEN.width / 2 - centre.x * scale,
    offsetY: SCREEN.height / 2 - centre.y * scale,
  };
}

// Whether a box in board units is on screen, without the culling margin.
function overlaps(bounds: Rect, viewport: Viewport): boolean {
  const left = -viewport.offsetX / viewport.scale;
  const top = -viewport.offsetY / viewport.scale;
  const right = left + SCREEN.width / viewport.scale;
  const bottom = top + SCREEN.height / viewport.scale;
  return (
    bounds.x <= right &&
    bounds.x + bounds.width >= left &&
    bounds.y <= bottom &&
    bounds.y + bounds.height >= top
  );
}

function verify(): string[] {
  const failures: string[] = [];
  const board = generateBoard(1_000);
  for (const object of board) {
    if (JSON.stringify(objectBounds(object)) !== JSON.stringify(referenceObjectBounds(object))) {
      failures.push(`bounds differ for ${object.id}`);
    }
  }
  const side = boardSide(1_000);
  for (const rect of marqueeRects(20, side)) {
    const live = objectsInRect(board, rect).map((object) => object.id);
    const reference = referenceObjectsInRect(board, rect).map((object) => object.id);
    if (JSON.stringify(live) !== JSON.stringify(reference)) {
      failures.push(`marquee differs at x=${rect.x}`);
    }
  }
  for (const point of [...randomPicks(side, 300), ...pickTargets(board.slice(0, 300))]) {
    const live = pickObject(board, point, 4)?.id ?? null;
    const reference = referencePickObject(board, point, 4)?.id ?? null;
    if (live !== reference) {
      failures.push(`pick differs at (${point.x.toFixed(2)}, ${point.y.toFixed(2)})`);
    }
  }
  const ids = board.slice(0, 50).map((object) => object.id);
  for (const scale of [1, 0.25]) {
    const viewport = viewportShowing({ x: side / 2, y: side / 2 }, scale);
    const plan = planScene(board, ids, viewport, SCREEN.width, SCREEN.height, null);
    const shown = new Set(plan.visible.map((object) => object.id));
    for (const object of board) {
      if (overlaps(objectBounds(object), viewport) && !shown.has(object.id)) {
        failures.push(`an object on screen was culled at scale ${scale}: ${object.id}`);
      }
    }
  }
  return failures;
}

function main(): void {
  const failures = verify();
  if (failures.length > 0) {
    console.error(`Equivalence check failed:\n${failures.slice(0, 10).join('\n')}`);
    process.exitCode = 1;
    return;
  }

  const results: Record<string, Record<string, Timing>> = {};
  const nodes: Record<string, Record<string, number>> = {};
  const { width, height } = SCREEN;

  for (const count of [1_000, 5_000]) {
    const board = generateBoard(count);
    results[`bounds, every object, no cached bounds (N=${count})`] = measureRounds({
      reference: timedCase(
        () => fresh(board),
        (objects) => objects.reduce((sum, object) => sum + referenceObjectBounds(object).x, 0),
      ),
      live: timedCase(
        () => fresh(board),
        (objects) => objects.reduce((sum, object) => sum + objectBounds(object).x, 0),
      ),
    });
  }

  const board5k = generateBoard(5_000);
  const side = boardSide(5_000);
  const rects = marqueeRects(50, side);
  results['marquee, 50 moves over a board of 5,000 (per 50 moves)'] = measureRounds({
    reference: timedCase(
      () => board5k,
      (objects) =>
        rects.reduce((sum, rect) => sum + referenceObjectsInRect(objects, rect).length, 0),
    ),
    live: timedCase(
      () => board5k,
      (objects) => rects.reduce((sum, rect) => sum + objectsInRect(objects, rect).length, 0),
    ),
  });

  const allIds = board5k.map((object) => object.id);
  const fullView = viewportShowing({ x: side / 2, y: side / 2 }, 0.05);
  const selectionLabel = 'selection lookup, all 5,000 selected (whole board in view)';
  results[selectionLabel] = measureRounds({
    reference: timedCase(
      () => allIds,
      (ids) => referenceSelectedObjects(board5k, ids).length,
    ),
    live: timedCase(
      () => allIds,
      (ids) => {
        const plan = planScene(board5k, ids, fullView, width, height, null);
        return plan.selectedVisible.length;
      },
    ),
  });

  for (const count of [1_000, 5_000]) {
    const board = count === 5_000 ? board5k : generateBoard(count);
    const boardCentre = { x: boardSide(count) / 2, y: boardSide(count) / 2 };
    for (const scale of [1, 0.25]) {
      const label = `scene, nothing selected, ${width}x${height} view at ${scale}x (N=${count})`;
      const viewport = viewportShowing(boardCentre, scale);
      results[label] = measureRounds({
        // The reference only filters the list and draws nothing, so its time is not comparable with
        // the live plan's. The nodes-drawn rows below are the measure of what culling changes.
        reference: timedCase(
          () => board,
          (objects) => objects.filter((object) => object.id !== '').length,
        ),
        live: timedCase(
          () => board,
          (objects) => planScene(objects, [], viewport, width, height, null).visible.length,
        ),
      });
      nodes[label] = {
        reference: board.length,
        live: planScene(board, [], viewport, width, height, null).visible.length,
      };
    }
  }

  const picks = randomPicks(side, 200);
  results['pick at 200 points on a board of 5,000'] = measureRounds({
    reference: timedCase(
      () => board5k,
      (objects) =>
        picks.reduce((sum, point) => sum + (referencePickObject(objects, point, 4) ? 1 : 0), 0),
    ),
    live: timedCase(
      () => board5k,
      (objects) => picks.reduce((sum, point) => sum + (pickObject(objects, point, 4) ? 1 : 0), 0),
    ),
  });

  const environment = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
    rounds: `${WARMUP_ROUNDS} warm-up + ${MEASURED_ROUNDS} measured, variants interleaved`,
    checksum: Math.round(sink),
  };

  console.log(JSON.stringify(environment));
  for (const [name, variants] of Object.entries(results)) {
    for (const [variant, timing] of Object.entries(variants)) {
      const median = timing.medianMs.toFixed(3);
      const p95 = timing.p95Ms.toFixed(3);
      console.log(`${name} | ${variant} | median ${median} ms | p95 ${p95} ms`);
    }
  }
  for (const [name, counts] of Object.entries(nodes)) {
    const drawn = Object.entries(counts).map(([variant, count]) => `${variant} ${count}`);
    console.log(`${name} | nodes drawn | ${drawn.join(' | ')}`);
  }

  const jsonArgument = process.argv.find((argument) => argument.startsWith('--json='));
  if (jsonArgument) {
    writeFileSync(
      jsonArgument.slice('--json='.length),
      JSON.stringify({ environment, results, nodes }, null, 2),
    );
  }
}

main();
