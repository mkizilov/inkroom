import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as Y from 'yjs';
import {
  appendObject,
  boardExportSchema,
  MAX_IMPORT_BYTES,
  objectsMapOf,
  type CanvasObject,
} from '@inkroom/shared';
import { currentUserOf } from '../auth/middleware';
import type { DbExecutor } from '../db/client';
import { createBoard, deleteBoard } from '../db/repositories/boards';
import type { BoardStore } from '../persistence/store';
import { parseBody } from '../http/validation';
import { toBoard } from './routes';

// A stored update is kept under 1 MiB (see the payload check on yjs_document_updates). Objects are
// merged into batches of about this size, so one batch stays well under that limit even when its last
// object is large.
const BATCH_BYTES = 256 * 1024;

// Turns a list of objects, back to front, into Yjs updates. Each object is written in its own
// transaction, so the work grows with the number of objects, and the resulting updates are merged
// into batches. Replaying the updates in order rebuilds the objects in the same z-order.
export function importUpdates(objects: readonly CanvasObject[]): Uint8Array[] {
  const doc = new Y.Doc();
  const map = objectsMapOf(doc);
  const updates: Uint8Array[] = [];
  let batch: Uint8Array[] = [];
  let batchBytes = 0;
  const flush = () => {
    if (batch.length > 0) {
      updates.push(Y.mergeUpdates(batch));
      batch = [];
      batchBytes = 0;
    }
  };

  doc.on('update', (update: Uint8Array) => {
    batch.push(update);
    batchBytes += update.byteLength;
  });
  objects.forEach((object, index) => {
    doc.transact(() => appendObject(map, object, index));
    if (batchBytes >= BATCH_BYTES) {
      flush();
    }
  });
  flush();
  return updates;
}

export interface ImportRouteOptions {
  db: DbExecutor;
  store: BoardStore;
  requireUser: (request: FastifyRequest) => Promise<void>;
}

// Creates a board from an exported file. The body is limited to MAX_IMPORT_BYTES, and it is checked
// against the versioned schema before anything is written. The new board belongs to the caller, and
// its objects keep the ids and coordinates they were exported with.
export function registerImportRoutes(app: FastifyInstance, options: ImportRouteOptions): void {
  const { db, store, requireUser } = options;

  app.post(
    '/api/boards/import',
    { preHandler: requireUser, bodyLimit: MAX_IMPORT_BYTES },
    async (request, reply) => {
      const user = currentUserOf(request);
      const document = parseBody(boardExportSchema, request.body);
      const board = await createBoard(db, { ownerId: user.id, title: document.title });
      try {
        for (const update of importUpdates(document.objects)) {
          await store.appendUpdate(board.id, user.id, update);
        }
      } catch (error) {
        await deleteBoard(db, board.id);
        throw error;
      }
      return reply.code(201).send({ board: toBoard(board, 'owner') });
    },
  );
}
