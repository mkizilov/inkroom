import { colorForUser, type Awareness, type Point, type PresenceState } from '@inkroom/shared';
import type { TimerLike } from '../sync/provider';
import { createThrottle, type ThrottledCall } from './throttle';

// Cursor updates are sent at most this often. Selection and identity changes go out at once.
export const CURSOR_INTERVAL_MS = 50;

export interface PresenceUserInfo {
  id: string;
  name: string;
}

export interface PresenceControllerOptions {
  throttleMs?: number;
  timers: TimerLike;
}

// Publishes this participant's presence: who they are, where their pointer is in world coordinates,
// and which objects they have selected. The viewport is not published. Each client places cursors
// with its own viewport, so presence is correct whatever zoom or pan the other client uses.
export class PresenceController {
  private cursor: Point | null = null;
  private selection: string[] = [];
  private active = false;
  private readonly throttled: ThrottledCall;

  constructor(
    private readonly awareness: Awareness,
    private readonly user: PresenceUserInfo,
    options: PresenceControllerOptions,
  ) {
    this.throttled = createThrottle(
      () => this.publish(),
      options.throttleMs ?? CURSOR_INTERVAL_MS,
      options.timers,
    );
  }

  start(): void {
    this.active = true;
    this.publish();
  }

  // Withdraws the participant. Other clients drop it on receipt.
  stop(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.throttled.cancel();
    this.awareness.setLocalState(null);
  }

  // The world-coordinate pointer position, or null when the pointer has left the canvas.
  setCursor(point: Point | null): void {
    if (!this.active) {
      return;
    }
    this.cursor = point;
    this.throttled.call();
  }

  setSelection(ids: readonly string[]): void {
    if (!this.active || sameIds(this.selection, ids)) {
      return;
    }
    this.selection = [...ids];
    this.throttled.call();
  }

  private publish(): void {
    const state: PresenceState = {
      user: {
        id: this.user.id,
        name: this.user.name,
        color: colorForUser(this.user.id),
      },
      cursor: this.cursor,
      selection: this.selection,
    };
    this.awareness.setLocalState(state);
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
