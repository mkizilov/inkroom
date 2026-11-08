import { z } from 'zod';

export const MAX_BOARD_TITLE_LENGTH = 200;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const boardRoleSchema = z.enum(['owner', 'editor', 'viewer']);

export const boardTitleSchema = z
  .string()
  .trim()
  .min(1, 'Enter a board name.')
  .max(MAX_BOARD_TITLE_LENGTH, `Use at most ${MAX_BOARD_TITLE_LENGTH} characters.`);

export const boardSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  ownerId: z.string().uuid(),
  role: boardRoleSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const boardResponseSchema = z.object({
  board: boardSchema,
});

export const boardPageSchema = z.object({
  items: z.array(boardSchema),
  nextCursor: z.string().nullable(),
});

export const createBoardRequestSchema = z.object({
  title: boardTitleSchema,
});

export const renameBoardRequestSchema = z.object({
  title: boardTitleSchema,
});

export const listBoardsQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1, `Use a limit of at least 1.`)
    .max(MAX_PAGE_SIZE, `Use a limit of at most ${MAX_PAGE_SIZE}.`)
    .default(DEFAULT_PAGE_SIZE),
});

export const boardIdParamsSchema = z.object({
  boardId: z.string().uuid(),
});

export type BoardRole = z.infer<typeof boardRoleSchema>;
export type Board = z.infer<typeof boardSchema>;
export type BoardPage = z.infer<typeof boardPageSchema>;
