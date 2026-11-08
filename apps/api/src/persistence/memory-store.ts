import * as Y from 'yjs';
import type {
  BoardStore,
  RestoreResult,
  RevisionContent,
  RevisionMeta,
  SweepResult,
} from './store';

// An in-memory BoardStore for unit tests of the sync room. It keeps the same contract as the
// database store for appends and loads, and it can be told to reject the next appends, which is how
// tests check that a failed write is never applied, broadcast or acknowledged. History operations
// are not supported here; they are covered by the database integration tests.
export class MemoryBoardStore implements BoardStore {
  readonly updates = new Map<string, Array<{ seq: number; payload: Uint8Array }>>();
  failNextAppends = 0;
  private lastSeq = 0;

  async load(boardId: string): Promise<Y.Doc> {
    const doc = new Y.Doc();
    for (const row of this.updates.get(boardId) ?? []) {
      Y.applyUpdate(doc, row.payload);
    }
    return doc;
  }

  async appendUpdate(boardId: string, _actorId: string, update: Uint8Array): Promise<number> {
    if (this.failNextAppends > 0) {
      this.failNextAppends -= 1;
      throw new Error('simulated write failure');
    }
    this.lastSeq += 1;
    const rows = this.updates.get(boardId) ?? [];
    rows.push({ seq: this.lastSeq, payload: Uint8Array.from(update) });
    this.updates.set(boardId, rows);
    return this.lastSeq;
  }

  async compact(): Promise<RevisionMeta | null> {
    return null;
  }

  async compactDue(): Promise<SweepResult> {
    return { compacted: 0, failed: [] };
  }

  async listRevisions(): Promise<RevisionMeta[]> {
    return [];
  }

  async getRevision(): Promise<RevisionContent> {
    throw new Error('revisions are not supported by the memory store');
  }

  async restore(): Promise<RestoreResult> {
    throw new Error('restore is not supported by the memory store');
  }
}
