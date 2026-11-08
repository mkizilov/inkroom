export interface FailureLimiter {
  retryAfterSeconds(key: string): number;
  recordFailure(key: string): void;
  reset(key: string): void;
}

interface FailureWindow {
  count: number;
  startedAt: number;
}

const MAX_TRACKED_KEYS = 10_000;

// Fixed-window counter of failed attempts per key. State is in memory, so limits reset on restart
// and are not shared between API instances.
export function createFailureLimiter({
  maxFailures,
  windowMs,
  now = Date.now,
}: {
  maxFailures: number;
  windowMs: number;
  now?: () => number;
}): FailureLimiter {
  const windows = new Map<string, FailureWindow>();

  const current = (key: string): FailureWindow | undefined => {
    const window = windows.get(key);
    if (window && now() - window.startedAt >= windowMs) {
      windows.delete(key);
      return undefined;
    }
    return window;
  };

  const pruneExpired = () => {
    for (const key of windows.keys()) {
      current(key);
    }
  };

  return {
    retryAfterSeconds(key) {
      const window = current(key);
      if (!window || window.count < maxFailures) {
        return 0;
      }
      return Math.ceil((window.startedAt + windowMs - now()) / 1000);
    },
    recordFailure(key) {
      const window = current(key);
      if (window) {
        window.count += 1;
        return;
      }
      if (windows.size >= MAX_TRACKED_KEYS) {
        pruneExpired();
      }
      windows.set(key, { count: 1, startedAt: now() });
    },
    reset(key) {
      windows.delete(key);
    },
  };
}
