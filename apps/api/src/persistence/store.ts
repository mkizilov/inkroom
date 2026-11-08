import * as Y from 'yjs';
import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm';
import {
  diffDocuments,
  objectsMapOf,
  readOrderedObjects,
  writeOperations,
  type CanvasObject,
} from '@inkroom/shared';
import type { DbExecutor } from '../db/client';
import { firstRow } from '../db/rows';
import {
  boardMemberships,
  boardSnapshots,
  users,
  yjsDocumentUpdates,
  type BoardRole,
} from '../db/schema';

// Durable storage for board documents. Every board has an append-only log of Yjs updates and a
// series of snapshots. A snapshot covers every update up to its `upToSeq`, so a board's state is
// its latest snapshot plus the updates after it.
//
// Two rules keep the log consistent under concurrency and interruption:
//   1. Every operation takes a row lock on the board inside a transaction. Writes take it
//      exclusively and are held until commit, so committed updates are ordered by sequence number
//      and a snapshot never misses an update that commits late.
//   2. Compaction and restore insert their snapshot and change the log in the same transaction.
//      A failure leaves the previous state in place.

export class BoardNotFoundError extends Error {
  constructor(boardId: string) {
    super(`Board ${boardId} does not exist.`);
    this.name = 'BoardNotFoundError';
  }
}

export class RevisionNotFoundError extends Error {
  constructor(boardId: string, revision: number) {
    super(`Board ${boardId} has no revision ${revision}.`);
    this.name = 'RevisionNotFoundError';
  }
}

// A write or restore from someone whose role does not allow it. The check runs inside the same
// transaction as the write, under the board lock, so a revocation that committed earlier is seen.
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export type RevisionKind = 'compaction' | 'restore';

export interface RevisionMeta {
  revision: number;
  kind: RevisionKind;
  upToSeq: number;
  createdAt: Date;
  createdBy: { id: string; displayName: string } | null;
  restoredFrom: number | null;
}

export interface RevisionContent {
  meta: RevisionMeta;
  objects: CanvasObject[];
}

export interface RestoreResult {
  changed: boolean;
  revision: RevisionMeta | null;
  // The update that moved the board to the restored content. Already stored; live rooms apply it.
  update: Uint8Array | null;
}

export interface CompactionHooks {
  // Runs inside the compaction transaction, before commit. Tests use it to simulate a crash.
  beforeCommit?: () => Promise<void>;
}

export interface SweepResult {
  compacted: number;
  failed: Array<{ boardId: string; error: unknown }>;
}

export interface BoardStore {
  load(boardId: string): Promise<Y.Doc>;
  appendUpdate(boardId: string, actorId: string, update: Uint8Array): Promise<number>;
  compact(boardId: string, hooks?: CompactionHooks): Promise<RevisionMeta | null>;
  compactDue(threshold: number): Promise<SweepResult>;
  listRevisions(boardId: string): Promise<RevisionMeta[]>;
  getRevision(boardId: string, revision: number): Promise<RevisionContent>;
  restore(boardId: string, revision: number, actorId: string): Promise<RestoreResult>;
}

export type SkippedUpdateHandler = (boardId: string, seq: number, error: unknown) => void;

interface History {
  doc: Y.Doc;
  baseSeq: number;
  lastSeq: number;
}

type SnapshotRow = typeof boardSnapshots.$inferSelect;

async function lockBoard(
  exec: DbExecutor,
  boardId: string,
  mode: 'share' | 'update',
): Promise<void> {
  const statement =
    mode === 'share'
      ? sql`select id from boards where id = ${boardId} for share`
      : sql`select id from boards where id = ${boardId} for update`;
  const result = await exec.execute<{ id: string }>(statement);
  if (result.rows.length === 0) {
    throw new BoardNotFoundError(boardId);
  }
}

// Rebuilds the document from the latest snapshot and the updates after it. An update that cannot be
// applied is reported and skipped, so one unreadable row cannot make the whole board unloadable.
async function readHistory(
  exec: DbExecutor,
  boardId: string,
  onSkipped: SkippedUpdateHandler,
): Promise<History> {
  const [base] = await exec
    .select()
    .from(boardSnapshots)
    .where(eq(boardSnapshots.boardId, boardId))
    .orderBy(desc(boardSnapshots.upToSeq))
    .limit(1);
  const baseSeq = base?.upToSeq ?? 0;
  const rows = await exec
    .select({ seq: yjsDocumentUpdates.seq, payload: yjsDocumentUpdates.payload })
    .from(yjsDocumentUpdates)
    .where(and(eq(yjsDocumentUpdates.boardId, boardId), gt(yjsDocumentUpdates.seq, baseSeq)))
    .orderBy(asc(yjsDocumentUpdates.seq));

  const doc = new Y.Doc();
  if (base) {
    Y.applyUpdate(doc, base.state);
  }
  for (const row of rows) {
    try {
      Y.applyUpdate(doc, row.payload);
    } catch (error) {
      onSkipped(boardId, row.seq, error);
    }
  }
  return { doc, baseSeq, lastSeq: rows.at(-1)?.seq ?? baseSeq };
}

async function insertUpdate(
  exec: DbExecutor,
  boardId: string,
  authorId: string | null,
  update: Uint8Array,
): Promise<number> {
  const rows = await exec
    .insert(yjsDocumentUpdates)
    .values({ boardId, authorId, payload: Buffer.from(update) })
    .returning({ seq: yjsDocumentUpdates.seq });
  return firstRow(rows, 'yjs_document_updates insert').seq;
}

async function nextRevision(exec: DbExecutor, boardId: string): Promise<number> {
  const [row] = await exec
    .select({ current: sql<number>`coalesce(max(${boardSnapshots.revision}), 0)` })
    .from(boardSnapshots)
    .where(eq(boardSnapshots.boardId, boardId));
  return Number(row?.current ?? 0) + 1;
}

// Reads the user's role on the board and refuses unless it is one of the allowed roles. Call it
// after lockBoard, inside the same transaction as the change it guards.
async function requireRole(
  exec: DbExecutor,
  boardId: string,
  userId: string,
  allowed: readonly BoardRole[],
): Promise<void> {
  const [row] = await exec
    .select({ role: boardMemberships.role })
    .from(boardMemberships)
    .where(and(eq(boardMemberships.boardId, boardId), eq(boardMemberships.userId, userId)))
    .limit(1);
  if (!row || !allowed.includes(row.role)) {
    throw new AuthorizationError('this user may not change the board');
  }
}

function creatorOf(row: { creatorId: string | null; creatorName: string | null }) {
  return row.creatorId !== null && row.creatorName !== null
    ? { id: row.creatorId, displayName: row.creatorName }
    : null;
}

function metaOf(
  snapshot: SnapshotRow,
  creator: { id: string; displayName: string } | null,
): RevisionMeta {
  return {
    revision: snapshot.revision,
    // The database check constraint limits this column to the two kinds below.
    kind: snapshot.kind as RevisionKind,
    upToSeq: snapshot.upToSeq,
    createdAt: snapshot.createdAt,
    createdBy: creator,
    restoredFrom: snapshot.restoredFrom,
  };
}

async function findRevision(exec: DbExecutor, boardId: string, revision: number) {
  const [row] = await exec
    .select({
      snapshot: boardSnapshots,
      creatorId: users.id,
      creatorName: users.displayName,
    })
    .from(boardSnapshots)
    .leftJoin(users, eq(users.id, boardSnapshots.createdBy))
    .where(and(eq(boardSnapshots.boardId, boardId), eq(boardSnapshots.revision, revision)))
    .limit(1);
  return row ? { snapshot: row.snapshot, meta: metaOf(row.snapshot, creatorOf(row)) } : null;
}

export class PostgresBoardStore implements BoardStore {
  constructor(
    private readonly db: DbExecutor,
    private readonly onSkippedUpdate: SkippedUpdateHandler,
  ) {}

  load(boardId: string): Promise<Y.Doc> {
    return this.db.transaction(async (tx) => {
      await lockBoard(tx, boardId, 'share');
      return (await readHistory(tx, boardId, this.onSkippedUpdate)).doc;
    });
  }

  // Only owners and editors may write. The role is read under the lock, so a change in membership
  // committed before this write is always seen.
  appendUpdate(boardId: string, actorId: string, update: Uint8Array): Promise<number> {
    return this.db.transaction(async (tx) => {
      await lockBoard(tx, boardId, 'update');
      await requireRole(tx, boardId, actorId, ['owner', 'editor']);
      return insertUpdate(tx, boardId, actorId, update);
    });
  }

  // Folds the board's updates into a new snapshot and removes the updates it covers. Nothing
  // changes unless the snapshot is written, so an interrupted compaction leaves the board intact.
  compact(boardId: string, hooks: CompactionHooks = {}): Promise<RevisionMeta | null> {
    return this.db.transaction(async (tx) => {
      await lockBoard(tx, boardId, 'update');
      const history = await readHistory(tx, boardId, this.onSkippedUpdate);

      if (history.lastSeq === history.baseSeq) {
        // Nothing new. Drop any stored updates that a snapshot already covers.
        await tx
          .delete(yjsDocumentUpdates)
          .where(
            and(
              eq(yjsDocumentUpdates.boardId, boardId),
              lte(yjsDocumentUpdates.seq, history.baseSeq),
            ),
          );
        return null;
      }

      const state = Buffer.from(Y.encodeStateAsUpdate(history.doc));
      const revision = await nextRevision(tx, boardId);
      const [snapshot] = await tx
        .insert(boardSnapshots)
        .values({ boardId, upToSeq: history.lastSeq, state, revision, kind: 'compaction' })
        .returning();
      if (!snapshot) {
        throw new Error('the compaction snapshot was not written');
      }
      await tx
        .delete(yjsDocumentUpdates)
        .where(
          and(
            eq(yjsDocumentUpdates.boardId, boardId),
            lte(yjsDocumentUpdates.seq, history.lastSeq),
          ),
        );
      await hooks.beforeCommit?.();
      return metaOf(snapshot, null);
    });
  }

  // Compacts every board with more than `threshold` stored updates. One board's failure does not
  // stop the others; each failure is returned so the caller can report it.
  async compactDue(threshold: number): Promise<SweepResult> {
    const due = await this.db.execute<{ board_id: string }>(
      sql`select board_id from yjs_document_updates
        group by board_id having count(*) > ${threshold} limit 50`,
    );
    const result: SweepResult = { compacted: 0, failed: [] };
    for (const row of due.rows) {
      try {
        if (await this.compact(row.board_id)) {
          result.compacted += 1;
        }
      } catch (error) {
        result.failed.push({ boardId: row.board_id, error });
      }
    }
    return result;
  }

  async listRevisions(boardId: string): Promise<RevisionMeta[]> {
    const rows = await this.db
      .select({
        snapshot: boardSnapshots,
        creatorId: users.id,
        creatorName: users.displayName,
      })
      .from(boardSnapshots)
      .leftJoin(users, eq(users.id, boardSnapshots.createdBy))
      .where(eq(boardSnapshots.boardId, boardId))
      .orderBy(asc(boardSnapshots.revision));
    return rows.map((row) => metaOf(row.snapshot, creatorOf(row)));
  }

  async getRevision(boardId: string, revision: number): Promise<RevisionContent> {
    const found = await findRevision(this.db, boardId, revision);
    if (!found) {
      throw new RevisionNotFoundError(boardId, revision);
    }
    const doc = new Y.Doc();
    Y.applyUpdate(doc, found.snapshot.state);
    return { meta: found.meta, objects: readOrderedObjects(objectsMapOf(doc)).objects };
  }

  // Makes the current content equal to a stored revision. The change is written as ordinary
  // updates, so every connected client receives it, and it is recorded as a new revision that
  // points at the one it restores. Earlier revisions are not changed.
  restore(boardId: string, revision: number, actorId: string): Promise<RestoreResult> {
    return this.db.transaction(async (tx) => {
      await lockBoard(tx, boardId, 'update');
      await requireRole(tx, boardId, actorId, ['owner']);
      const target = await findRevision(tx, boardId, revision);
      if (!target) {
        throw new RevisionNotFoundError(boardId, revision);
      }

      const current = await readHistory(tx, boardId, this.onSkippedUpdate);
      const targetDoc = new Y.Doc();
      Y.applyUpdate(targetDoc, target.snapshot.state);
      const before = readOrderedObjects(objectsMapOf(current.doc)).objects;
      const after = readOrderedObjects(objectsMapOf(targetDoc)).objects;
      const operations = diffDocuments(before, after);
      if (operations.length === 0) {
        return { changed: false, revision: null, update: null };
      }

      const captured: Uint8Array[] = [];
      const record = (update: Uint8Array) => {
        captured.push(update);
      };
      current.doc.on('update', record);
      current.doc.transact(() => {
        writeOperations(objectsMapOf(current.doc), operations);
      });
      current.doc.off('update', record);

      const update = Y.mergeUpdates(captured);
      const seq = await insertUpdate(tx, boardId, actorId, update);
      const state = Buffer.from(Y.encodeStateAsUpdate(current.doc));
      const number = await nextRevision(tx, boardId);
      await tx.insert(boardSnapshots).values({
        boardId,
        upToSeq: seq,
        state,
        revision: number,
        kind: 'restore',
        restoredFrom: revision,
        createdBy: actorId,
      });
      const created = await findRevision(tx, boardId, number);
      if (!created) {
        throw new Error('the restored revision was not found after it was written');
      }
      return { changed: true, revision: created.meta, update };
    });
  }
}
