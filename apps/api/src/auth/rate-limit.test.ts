import { describe, expect, it } from 'vitest';
import { createFailureLimiter } from './rate-limit';

describe('createFailureLimiter', () => {
  it('blocks a key after the maximum number of failures within the window', () => {
    let now = 0;
    const limiter = createFailureLimiter({ maxFailures: 3, windowMs: 60_000, now: () => now });

    limiter.recordFailure('a');
    limiter.recordFailure('a');
    expect(limiter.retryAfterSeconds('a')).toBe(0);

    limiter.recordFailure('a');
    now = 15_000;
    expect(limiter.retryAfterSeconds('a')).toBe(45);
    expect(limiter.retryAfterSeconds('b')).toBe(0);
  });

  it('unblocks when the window expires', () => {
    let now = 0;
    const limiter = createFailureLimiter({ maxFailures: 1, windowMs: 1_000, now: () => now });

    limiter.recordFailure('a');
    expect(limiter.retryAfterSeconds('a')).toBe(1);

    now = 1_000;
    expect(limiter.retryAfterSeconds('a')).toBe(0);
  });

  it('clears a key on reset', () => {
    const limiter = createFailureLimiter({ maxFailures: 1, windowMs: 60_000 });

    limiter.recordFailure('a');
    limiter.reset('a');

    expect(limiter.retryAfterSeconds('a')).toBe(0);
  });
});
