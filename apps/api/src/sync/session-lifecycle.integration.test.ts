import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { issueSession, revokeSession } from '../auth/service';
import { hashSessionToken } from '../auth/session-token';
import { createBoard } from '../db/repositories/boards';
import { createUser } from '../db/repositories/users';
import {
  createTestDatabase,
  describeWithDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from '../db/test-database';
import { PostgresBoardStore } from '../persistence/store';
import { CLOSE_POLICY_VIOLATION, DEFAULT_CONNECTION_LIMITS, type SocketLike } from './connections';
import { SESSION_ENDED_REASON, SyncService } from './service';

// A socket that records how it was closed, so tests can see what the server told the client.
class RecordingSocket implements SocketLike {
  closedWith: { code: number; reason: string } | undefined;

  send(): void {}
  ping(): void {}
  terminate(): void {}
  readonly bufferedAmount = 0;

  get readyState(): 'open' | 'closed' {
    return this.closedWith ? 'closed' : 'open';
  }

  close(code: number, reason: string): void {
    this.closedWith ??= { code, reason };
  }
}

describeWithDatabase('sessions and open sockets', () => {
  let database: TestDatabase;
  let service: SyncService;

  beforeAll(async () => {
    database = await createTestDatabase(testDatabaseUrl ?? '');
    service = new SyncService({
      db: database.db,
      store: new PostgresBoardStore(database.db, () => undefined),
      connectionLimits: DEFAULT_CONNECTION_LIMITS,
      membershipCheckMs: 0,
      sweepIntervalMs: 0,
      logger: { error: () => undefined, warn: () => undefined },
    });
  });

  afterAll(async () => {
    await service.shutdown();
    await database.drop();
  });

  // Signs a user in, opens a board socket with that session, and returns the pieces a test needs.
  async function openSocket() {
    const user = await createUser(database.db, {
      email: `${randomUUID()}@example.com`,
      displayName: 'Session tester',
      passwordHash: 'test-hash',
    });
    const board = await createBoard(database.db, { ownerId: user.id, title: 'Sessions' });
    const token = await issueSession(database.db, user.id);
    const socket = new RecordingSocket();
    const result = await service.open({
      user: { id: user.id, email: user.email, displayName: user.displayName },
      boardId: board.id,
      socket,
      sessionHash: hashSessionToken(token),
    });
    if (!result.ok) {
      throw new Error(`the socket did not open: ${result.reason}`);
    }
    return { token, socket };
  }

  it('closes the socket at once when its session is ended, and tells the client why', async () => {
    const { token, socket } = await openSocket();

    service.endSession(hashSessionToken(token));

    expect(socket.closedWith).toEqual({
      code: CLOSE_POLICY_VIOLATION,
      reason: SESSION_ENDED_REASON,
    });
  });

  it('closes a socket whose session was revoked elsewhere at the next access check', async () => {
    const { token, socket } = await openSocket();

    await revokeSession(database.db, token);
    expect(socket.closedWith).toBeUndefined();

    await service.reconcileSessions();

    expect(socket.closedWith?.reason).toBe(SESSION_ENDED_REASON);
  });

  it('leaves the socket open while its session is still active', async () => {
    const { socket } = await openSocket();

    await service.reconcileSessions();

    expect(socket.closedWith).toBeUndefined();
  });

  it('ends only the sockets of the session that was signed out', async () => {
    const signedOut = await openSocket();
    const stillSignedIn = await openSocket();

    service.endSession(hashSessionToken(signedOut.token));

    expect(signedOut.socket.closedWith?.reason).toBe(SESSION_ENDED_REASON);
    expect(stillSignedIn.socket.closedWith).toBeUndefined();
  });
});
