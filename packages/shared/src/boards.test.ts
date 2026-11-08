import { describe, expect, it } from 'vitest';
import {
  boardIdParamsSchema,
  boardTitleSchema,
  createBoardRequestSchema,
  listBoardsQuerySchema,
} from './boards';

describe('board title validation', () => {
  it('trims titles and rejects blank or overlong ones', () => {
    expect(boardTitleSchema.parse('  Sprint 4  ')).toBe('Sprint 4');
    expect(boardTitleSchema.safeParse('   ').error?.issues[0]?.message).toBe('Enter a board name.');
    expect(boardTitleSchema.safeParse('x'.repeat(201)).success).toBe(false);
    expect(boardTitleSchema.safeParse('x'.repeat(200)).success).toBe(true);
  });

  it('reports the field name for create requests', () => {
    const result = createBoardRequestSchema.safeParse({ title: '' });
    expect(result.error?.issues[0]?.path).toEqual(['title']);
  });
});

describe('listBoardsQuerySchema', () => {
  it('defaults the page size to 20 and parses numeric strings', () => {
    expect(listBoardsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(listBoardsQuerySchema.parse({ limit: '5' })).toEqual({ limit: 5 });
  });

  it('rejects page sizes outside 1 to 100 and non-numeric values', () => {
    expect(listBoardsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listBoardsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listBoardsQuerySchema.safeParse({ limit: 'many' }).success).toBe(false);
  });

  it('accepts an opaque cursor and rejects an empty one', () => {
    expect(listBoardsQuerySchema.parse({ cursor: 'abc' }).cursor).toBe('abc');
    expect(listBoardsQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
  });
});

describe('boardIdParamsSchema', () => {
  it('requires a UUID board id', () => {
    expect(boardIdParamsSchema.safeParse({ boardId: 'not-a-uuid' }).success).toBe(false);
    expect(
      boardIdParamsSchema.safeParse({ boardId: '00000000-0000-4000-8000-000000000001' }).success,
    ).toBe(true);
  });
});
