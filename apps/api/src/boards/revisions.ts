import type { FastifyInstance, FastifyRequest } from 'fastify';
import { revisionParamsSchema, type Revision } from '@inkroom/shared';
import type { DbExecutor } from '../db/client';
import { currentUserOf } from '../auth/middleware';
import { RevisionNotFoundError, type RevisionMeta, type BoardStore } from '../persistence/store';
import { AppError } from '../http/errors';
import { parseParams } from '../http/validation';
import type { SyncService } from '../sync/service';
import { authorizeBoard } from './access';

export interface RevisionRouteOptions {
  db: DbExecutor;
  store: BoardStore;
  sync: SyncService;
  requireUser: (request: FastifyRequest) => Promise<void>;
}

export function toRevisionJson(meta: RevisionMeta): Revision {
  return {
    revision: meta.revision,
    kind: meta.kind,
    upToSeq: meta.upToSeq,
    createdAt: meta.createdAt.toISOString(),
    createdBy: meta.createdBy,
    restoredFrom: meta.restoredFrom,
  };
}

// Maps the store's "not found" onto the API's 404, so the response shape matches the other routes.
function translate(error: unknown): unknown {
  if (error instanceof RevisionNotFoundError) {
    return new AppError(404, 'revision_not_found', 'Revision not found.');
  }
  return error;
}

// Browsing is open to every member. Restoring is owner-only and is recorded as a new revision.
export function registerRevisionRoutes(app: FastifyInstance, options: RevisionRouteOptions): void {
  const { db, store, sync, requireUser } = options;

  app.get<{ Params: { boardId: string } }>(
    '/api/boards/:boardId/revisions',
    { preHandler: requireUser },
    async (request) => {
      const user = currentUserOf(request);
      const { boardId } = parseParams(revisionParamsSchema.pick({ boardId: true }), request.params);
      await authorizeBoard(db, boardId, user.id, 'read');
      const revisions = await store.listRevisions(boardId);
      return { items: revisions.map(toRevisionJson) };
    },
  );

  app.get<{ Params: { boardId: string; revision: string } }>(
    '/api/boards/:boardId/revisions/:revision',
    { preHandler: requireUser },
    async (request) => {
      const user = currentUserOf(request);
      const { boardId, revision } = parseParams(revisionParamsSchema, request.params);
      await authorizeBoard(db, boardId, user.id, 'read');
      const content = await store.getRevision(boardId, revision).catch((error: unknown) => {
        throw translate(error);
      });
      return { revision: toRevisionJson(content.meta), objects: content.objects };
    },
  );

  app.post<{ Params: { boardId: string; revision: string } }>(
    '/api/boards/:boardId/revisions/:revision/restore',
    { preHandler: requireUser },
    async (request, reply) => {
      const user = currentUserOf(request);
      const { boardId, revision } = parseParams(revisionParamsSchema, request.params);
      await authorizeBoard(db, boardId, user.id, 'restore');
      const result = await store.restore(boardId, revision, user.id).catch((error: unknown) => {
        throw translate(error);
      });
      // The change is stored. Connected editors receive it now, without waiting for a reconnect.
      if (result.update) {
        await sync.applyPersisted(boardId, result.update);
      }
      if (!result.changed || !result.revision) {
        return reply.code(200).send({ changed: false, revision: null });
      }
      return reply.code(201).send({ changed: true, revision: toRevisionJson(result.revision) });
    },
  );
}
