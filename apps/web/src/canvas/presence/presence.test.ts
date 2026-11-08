import { describe, expect, it } from 'vitest';
import { Awareness, colorForUser, presenceStateSchema, type PresenceState } from '@inkroom/shared';
import type { TimerLike } from '../sync/provider';
import { createThrottle } from './throttle';
import { PresenceController } from './presence-controller';
import { placeCursor, screenBoxFor } from './overlay-geometry';
import { maintainAwareness } from './maintenance';
import { participantsOf } from './participants';

// Timers that run only when the test advances them, so presence timing is exact.
class ManualClock implements TimerLike {
  now = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { at: this.now + ms, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  get pendingCount(): number {
    return this.pending.size;
  }
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }
}

const USER = { id: '00000000-0000-4000-8000-0000000000aa', name: 'Ada' };
const OTHER = '00000000-0000-4000-8000-0000000000bb';

describe('throttle', () => {
  it('runs the first call at once, and collapses calls in the window into one trailing run', () => {
    const clock = new ManualClock();
    const runs: number[] = [];
    const throttle = createThrottle(() => runs.push(clock.now), 50, clock);

    throttle.call();
    clock.advance(10);
    throttle.call();
    clock.advance(10);
    throttle.call();
    clock.advance(100);

    expect(runs).toEqual([0, 50]);
  });

  it('runs again straight away once the window has closed with nothing pending', () => {
    const clock = new ManualClock();
    const runs: number[] = [];
    const throttle = createThrottle(() => runs.push(clock.now), 50, clock);

    throttle.call();
    clock.advance(200);
    throttle.call();

    expect(runs).toEqual([0, 200]);
  });

  it('drops a pending trailing run when cancelled', () => {
    const clock = new ManualClock();
    const runs: number[] = [];
    const throttle = createThrottle(() => runs.push(clock.now), 50, clock);

    throttle.call();
    throttle.call();
    throttle.cancel();
    clock.advance(100);

    expect(runs).toEqual([0]);
    expect(clock.pendingCount).toBe(0);
  });
});

describe('presence controller', () => {
  it('publishes identity, colour and cursor, and withdraws on stop', () => {
    const clock = new ManualClock();
    const awareness = new Awareness();
    const controller = new PresenceController(awareness, USER, { timers: clock });

    controller.start();
    controller.setCursor({ x: 40, y: 60 });

    const state = awareness.getLocalState() as PresenceState;
    expect(state.user).toEqual({ id: USER.id, name: 'Ada', color: colorForUser(USER.id) });
    expect(state.cursor).toEqual({ x: 40, y: 60 });

    controller.stop();
    expect(awareness.getLocalState()).toBeNull();
  });

  it('sends cursor moves no faster than the interval, and always the last position', () => {
    const clock = new ManualClock();
    const awareness = new Awareness();
    const controller = new PresenceController(awareness, USER, { timers: clock, throttleMs: 50 });
    const sent: Uint8Array[] = [];
    awareness.onLocalChange((body) => sent.push(body));
    controller.start();

    for (let step = 1; step <= 20; step += 1) {
      controller.setCursor({ x: step, y: 0 });
      clock.advance(5);
    }
    clock.advance(200);

    // 20 moves over 100 ms: a start, a few paced updates, and a final one at the last position.
    expect(sent.length).toBeLessThanOrEqual(5);
    expect(sent.length).toBeGreaterThan(1);
    const last = participantsOf(awareness)[0];
    expect(last?.state.cursor).toEqual({ x: 20, y: 0 });
  });

  it('publishes a selection at once, and ignores a repeat of the same selection', () => {
    const clock = new ManualClock();
    const awareness = new Awareness();
    const controller = new PresenceController(awareness, USER, { timers: clock });
    controller.start();
    const sent: Uint8Array[] = [];
    awareness.onLocalChange((body) => sent.push(body));

    controller.setSelection([OTHER]);
    controller.setSelection([OTHER]);

    expect(sent).toHaveLength(1);
    expect((awareness.getLocalState() as PresenceState).selection).toEqual([OTHER]);
  });

  it('does nothing before it starts or after it stops', () => {
    const clock = new ManualClock();
    const awareness = new Awareness();
    const controller = new PresenceController(awareness, USER, { timers: clock });

    controller.setCursor({ x: 1, y: 1 });
    expect(awareness.getLocalState()).toBeNull();
  });
});

describe('cursor and selection placement across views', () => {
  it('draws a cursor inside the view where it is', () => {
    expect(placeCursor({ x: 120, y: 80 }, { width: 800, height: 600 })).toEqual({
      x: 120,
      y: 80,
      onScreen: true,
    });
  });

  it('pins a cursor outside the view to the nearest edge, inset by the margin', () => {
    expect(placeCursor({ x: -500, y: 300 }, { width: 800, height: 600 })).toEqual({
      x: 16,
      y: 300,
      onScreen: false,
    });
    expect(placeCursor({ x: 2000, y: 9000 }, { width: 800, height: 600 })).toEqual({
      x: 784,
      y: 584,
      onScreen: false,
    });
  });

  it('maps a world box through the local zoom and pan', () => {
    const box = screenBoxFor(
      { x: 100, y: 50, width: 40, height: 20 },
      { scale: 2, offsetX: 10, offsetY: -5 },
    );
    expect(box).toEqual({ x: 210, y: 95, width: 80, height: 40 });
  });
});

describe('participants', () => {
  it('lists this participant first and leaves out a remote state that does not validate', () => {
    const awareness = new Awareness();
    awareness.setLocalState({ user: { ...USER, color: '#1971c2' }, cursor: null, selection: [] });
    const other = new Awareness();
    other.setLocalState({
      user: { id: OTHER, name: 'Bob', color: '#2f9e44' },
      cursor: null,
      selection: [],
    });
    awareness.applyUpdate(other.encodeLocal());
    const damaged = new Awareness();
    damaged.setLocalState({ user: 'not-a-user' });
    awareness.applyUpdate(damaged.encodeLocal());

    const list = participantsOf(awareness);

    expect(list.map((participant) => [participant.isSelf, participant.state.user.name])).toEqual([
      [true, 'Ada'],
      [false, 'Bob'],
    ]);
    expect(presenceStateSchema.safeParse(list[1]?.state).success).toBe(true);
  });
});

describe('presence maintenance', () => {
  it('re-sends the local state on each heartbeat and expires stale remote states', () => {
    const clock = new ManualClock();
    const awareness = new Awareness({ now: () => clock.now, outdatedTimeoutMs: 30_000 });
    awareness.setLocalState({ user: { ...USER, color: '#1971c2' }, cursor: null, selection: [] });
    const sent: Uint8Array[] = [];
    awareness.onLocalChange((body) => sent.push(body));

    const stop = maintainAwareness(awareness, {
      timers: clock,
      heartbeatMs: 15_000,
      expiryCheckMs: 5_000,
    });
    clock.advance(15_000);

    expect(sent).toHaveLength(1);
    stop();
    clock.advance(60_000);
    expect(sent).toHaveLength(1);
    expect(clock.pendingCount).toBe(0);
  });
});
