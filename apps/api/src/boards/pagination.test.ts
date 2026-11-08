import { describe, expect, it } from 'vitest';
import { AppError } from '../http/errors';
import { decodeCursor, encodeCursor } from './pagination';

const position = {
  updatedAt: new Date('2026-03-04T05:06:07.890Z'),
  id: '00000000-0000-4000-8000-0000000000aa',
};

describe('board page cursors', () => {
  it('round-trips the sort position with millisecond precision', () => {
    const cursor = encodeCursor(position);

    expect(cursor).not.toContain('{');
    expect(decodeCursor(cursor)).toEqual(position);
  });

  it.each([
    ['not base64 json', '%%%'],
    ['valid json with the wrong shape', Buffer.from('{"x":1}').toString('base64url')],
    [
      'a malformed timestamp',
      Buffer.from(JSON.stringify({ u: 'yesterday', i: position.id })).toString('base64url'),
    ],
    [
      'a malformed id',
      Buffer.from(JSON.stringify({ u: position.updatedAt.toISOString(), i: 'abc' })).toString(
        'base64url',
      ),
    ],
  ])('rejects a cursor that is %s', (_label, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(AppError);
    try {
      decodeCursor(cursor);
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 400, code: 'validation_failed' });
    }
  });
});
