import { and, asc, desc, eq, gt } from 'drizzle-orm';
import type { DbExecutor } from '../client';
import { firstRow } from '../rows';
import { boardSnapshots, yjsDocumentUpdates } from '../schema';

// Yjs updates are an append-only log per board. `seq` is the global identity order and is
// used as the cursor when clients catch up.
export async function appendDocumentUpdate(
  db: DbExecutor,
  input: { boardId: string; authorId: string | null; payload: Buffer },
): Promise<number> {
  const rows = await db
    .insert(yjsDocumentUpdates)
    .values(input)
    .returning({ seq: yjsDocumentUpdates.seq });
  return firstRow(rows, 'yjs_document_updates insert').seq;
}

export function listDocumentUpdates(db: DbExecutor, boardId: string, afterSeq = 0) {
  return db
    .select({ seq: yjsDocumentUpdates.seq, payload: yjsDocumentUpdates.payload })
    .from(yjsDocumentUpdates)
    .where(and(eq(yjsDocumentUpdates.boardId, boardId), gt(yjsDocumentUpdates.seq, afterSeq)))
    .orderBy(asc(yjsDocumentUpdates.seq));
}

export async function saveSnapshot(
  db: DbExecutor,
  input: { boardId: string; upToSeq: number; state: Buffer },
) {
  const rows = await db.insert(boardSnapshots).values(input).returning();
  return firstRow(rows, 'board_snapshots insert');
}

export async function findLatestSnapshot(db: DbExecutor, boardId: string) {
  const [row] = await db
    .select()
    .from(boardSnapshots)
    .where(eq(boardSnapshots.boardId, boardId))
    .orderBy(desc(boardSnapshots.upToSeq))
    .limit(1);
  return row ?? null;
}
