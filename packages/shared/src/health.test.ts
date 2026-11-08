import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health';

const validResponse = {
  status: 'ok',
  service: 'inkroom-api',
  database: 'up',
  timestamp: '2026-01-01T00:00:00.000Z',
};

describe('healthResponseSchema', () => {
  it('accepts a healthy response', () => {
    expect(healthResponseSchema.parse(validResponse)).toEqual(validResponse);
  });

  it('accepts a degraded response when the database is down', () => {
    const degraded = { ...validResponse, status: 'degraded', database: 'down' };
    expect(healthResponseSchema.safeParse(degraded).success).toBe(true);
  });

  it('rejects unknown statuses', () => {
    expect(healthResponseSchema.safeParse({ ...validResponse, status: 'broken' }).success).toBe(
      false,
    );
  });

  it('rejects timestamps that are not ISO 8601', () => {
    expect(healthResponseSchema.safeParse({ ...validResponse, timestamp: 'yesterday' }).success).toBe(
      false,
    );
  });
});
