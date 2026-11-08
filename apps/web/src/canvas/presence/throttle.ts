import type { TimerLike } from '../sync/provider';

// The browser's timers behind the TimerLike shape, so presence code can be tested with fake timers.
export const browserTimers: TimerLike = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ThrottledCall {
  // Runs the action now if the window is open, or once more when the window closes.
  call(): void;
  cancel(): void;
}

// Leading and trailing throttle: the first call runs at once, calls inside the window collapse
// into a single trailing run at its end, and the last value is never lost. Cursor moves use this,
// so a
// fast pointer sends at most one update per interval.
export function createThrottle(
  action: () => void,
  intervalMs: number,
  timers: TimerLike,
): ThrottledCall {
  let handle: unknown = null;
  let trailing = false;

  const open = () => {
    handle = timers.setTimeout(() => {
      handle = null;
      if (trailing) {
        trailing = false;
        action();
        open();
      }
    }, intervalMs);
  };

  return {
    call() {
      if (handle === null) {
        action();
        open();
        return;
      }
      trailing = true;
    },
    cancel() {
      if (handle !== null) {
        timers.clearTimeout(handle);
        handle = null;
      }
      trailing = false;
    },
  };
}
