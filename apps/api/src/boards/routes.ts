import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  boardIdParamsSchema,
  createBoardRequestSchema,
  listBoardsQuerySchema,
  renameBoardRequestSchema,
  type Board,
  type BoardRole,
} from '@inkroom/shared';
import { currentUserOf } from '../auth/middleware';
import type { DbExecutor } from '../db/client';
import {
  createBoard,
  deleteBoard,
  findBoardById,
  listBoardsPageForUser,
  renameBoard,
} from '../db/repositories/boards';
import type { boards } from '../db/schema';
import { AppError } from '../http/errors';
import { parseBody, parseParams, parseQuery } from '../http/validation';
import type { SyncService } from '../sync/service';
import { authorizeBoard } from './access';
import { decodeCursor, encodeCursor } from './pagination';

export interface BoardRouteOptions {
  db: DbExecutor;
  requireUser: (request: FastifyRequest) => Promise<void>;
  sync: SyncService;
}

type BoardRow = typeof boards.$inferSelect;

function toBoard(row: BoardRow, role: BoardRole): Board {
  return {
    id: row.id,
    title: row.title,
    ownerId: row.ownerId,
    role,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function registerBoardRoutes(app: FastifyInstance, options: BoardRouteOptions): void {
  const { db, requireUser, sync } = options;

  app.post('/api/boards', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUserOf(request);
    const { title } = parseBody(createBoardRequestSchema, request.body);
    const row = await createBoard(db, { ownerId: user.id, title });
    return reply.code(201).send({ board: toBoard(row, 'owner') });
  });

  app.get('/api/boards', { preHandler: requireUser }, async (request) => {
    const user = currentUserOf(request);
    const query = parseQuery(listBoardsQuerySchema, request.query);
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;

    const page = await listBoardsPageForUser(db, user.id, { limit: query.limit, after });
    const last = page.items.at(-1);
    return {
      items: page.items.map((row) => toBoard(row, row.role)),
      nextCursor:
        page.hasMore && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
    };
  });

  app.get('/api/boards/:boardId', { preHandler: requireUser }, async (request) => {
    const user = currentUserOf(request);
    const { boardId } = parseParams(boardIdParamsSchema, request.params);
    const role = await authorizeBoard(db, boardId, user.id, 'read');
    const row = await findBoardById(db, boardId);
    if (!row) {
      throw new AppError(404, 'board_not_found', 'Board not found.');
    }
    return { board: toBoard(row, role) };
  });

  app.patch('/api/boards/:boardId', { preHandler: requireUser }, async (request) => {
    const user = currentUserOf(request);
    const { boardId } = parseParams(boardIdParamsSchema, request.params);
    const { title } = parseBody(renameBoardRequestSchema, request.body);
    const role = await authorizeBoard(db, boardId, user.id, 'rename');
    const row = await renameBoard(db, boardId, title);
    if (!row) {
      throw new AppError(404, 'board_not_found', 'Board not found.');
    }
    return { board: toBoard(row, role) };
  });

  app.delete('/api/boards/:boardId', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUserOf(request);
    const { boardId } = parseParams(boardIdParamsSchema, request.params);
    await authorizeBoard(db, boardId, user.id, 'delete');
    const deleted = await deleteBoard(db, boardId);
    if (!deleted) {
      throw new AppError(404, 'board_not_found', 'Board not found.');
    }
    // Everyone editing the board is disconnected at once, rather than on their next write.
    sync.boardDeleted(boardId);
    return reply.code(204).send();
  });
}
