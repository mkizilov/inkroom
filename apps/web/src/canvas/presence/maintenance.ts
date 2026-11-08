import type { Awareness } from '@inkroom/shared';
import type { TimerLike } from '../sync/provider';

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const EXPIRY_CHECK_INTERVAL_MS = 5_000;

export interface MaintenanceOptions {
  heartbeatMs?: number;
  expiryCheckMs?: number;
  timers: TimerLike;
}

// Keeps presence fresh while the editor is open. The heartbeat re-sends this participant's state,
// so an idle participant is not dropped as outdated. The expiry check removes remote participants
// whose heartbeats have stopped, for example a frozen tab on a connection that is still open.
// Returns a function that stops both.
export function maintainAwareness(awareness: Awareness, options: MaintenanceOptions): () => void {
  let stopped = false;
  // Holds only the timers that are still pending, so a long session does not accumulate entries.
  const pending = new Set<unknown>();

  const every = (ms: number, task: () => void): void => {
    const schedule = (): void => {
      const handle = options.timers.setTimeout(() => {
        pending.delete(handle);
        if (stopped) {
          return;
        }
        task();
        schedule();
      }, ms);
      pending.add(handle);
    };
    schedule();
  };

  every(options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS, () => awareness.refresh());
  every(options.expiryCheckMs ?? EXPIRY_CHECK_INTERVAL_MS, () => awareness.expireOutdated());

  return () => {
    stopped = true;
    for (const handle of pending) {
      options.timers.clearTimeout(handle);
    }
    pending.clear();
  };
}
