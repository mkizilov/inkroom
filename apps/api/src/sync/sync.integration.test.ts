import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { SyncClient, encodeSyncUpdate, type AuthUser } from '@inkroom/shared';
import { createBoard } from '../db/repositories/boards';
import { addMember } from '../db/repositories/memberships';
import { createUser } from '../db/repositories/users';
import {
  createTestDatabase,
  describeWithDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from '../db/test-database';
import { CLOSE_POLICY_VIOLATION, type SocketLike } from './connections';
import { SyncService, type OpenResult } from './service';

// Updates from the server are applied under this origin, as the browser provider does.
const REMOTE_ORIGIN = Symbol('remote');

type Joined = Extract<OpenResult, { ok: true }>;

// A socket that records what it was sent, so tests can read the frames a client would receive.
class FakeSocket implements SocketLike {
  readonly sent: Uint8Array[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  pings = 0;
  bufferedAmount = 0;
  readyState: 'open' | 'closed' = 'open';
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  ping(): void {
    this.pings += 1;
  }
  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
    this.readyState = 'closed';
  }
  terminate(): void {
    this.readyState = 'closed';
  }
}

const roomLimits = {
  maxPayloadBytes: 64 * 1024,
  maxConnectionsPerRoom: 10,
  maxUpdateBytesPerSecond: 1e7,
};
const connectionLimits = {
  maxFrameBytes: 64 * 1024,
  maxBufferedBytes: 1024 * 1024,
  maxConnectionsPerUser: 2,
  heartbeatTimeoutMs: 30_000,
  heartbeatIntervalMs: 15_000,
};

describeWithDatabase('board sync service', () => {
  let database: TestDatabase;
  let service: SyncService;

  beforeAll(async () => {
    database = await createTestDatabase(testDatabaseUrl ?? '');
    service = new SyncService({ db: database.db, roomLimits, connectionLimits });
  });

  afterAll(async () => {
    service.shutdown();
    await database.drop();
  });

  const openAs = (user: AuthUser, boardId: string) =>
    service.open({ user, boardId, socket: new FakeSocket() });

  const newUser = async (name: string) => {
    const user = await createUser(database.db, {
      email: `${randomUUID()}@example.com`,
      displayName: name,
      passwordHash: 'test-hash',
    });
    return { id: user.id, email: user.email, displayName: user.displayName };
  };

  it('admits an owner and a viewer, and marks the viewer read-only', async () => {
    const owner = await newUser('Owner');
    const viewer = await newUser('Viewer');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Shared' });
    await addMember(database.db, { boardId: board.id, userId: viewer.id, role: 'viewer' });

    const ownerResult = await openAs(owner, board.id);
    const viewerResult = await openAs(viewer, board.id);

    expect(ownerResult.ok && ownerResult.connection.readOnly).toBe(false);
    expect(viewerResult.ok && viewerResult.connection.readOnly).toBe(true);
  });

  it('refuses a user who is not a member, with the same answer as a missing board', async () => {
    const owner = await newUser('Owner');
    const stranger = await newUser('Stranger');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Private' });

    const forbidden = await openAs(stranger, board.id);
    const missing = await openAs(stranger, randomUUID());

    expect(forbidden).toMatchObject({ ok: false, code: CLOSE_POLICY_VIOLATION });
    expect(missing).toMatchObject({
      ok: false,
      code: CLOSE_POLICY_VIOLATION,
      reason: 'board not found',
    });
    expect(forbidden).toEqual(missing);
  });

  it('limits how many connections one user can hold', async () => {
    const owner = await newUser('Busy');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Busy board' });

    const first = await service.open({ user: owner, boardId: board.id, socket: new FakeSocket() });
    const second = await service.open({ user: owner, boardId: board.id, socket: new FakeSocket() });
    const third = await service.open({ user: owner, boardId: board.id, socket: new FakeSocket() });

    expect(first.ok && second.ok).toBe(true);
    expect(third).toMatchObject({ ok: false, reason: 'too many connections' });
  });

  it('releases a user connection budget when a connection closes', async () => {
    const owner = await newUser('Cycler');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Cycle' });

    const socketA = new FakeSocket();
    const first = await service.open({ user: owner, boardId: board.id, socket: socketA });
    await service.open({ user: owner, boardId: board.id, socket: new FakeSocket() });
    if (first.ok) first.connection.close(1000, 'bye');

    const again = await service.open({ user: owner, boardId: board.id, socket: new FakeSocket() });
    expect(again.ok).toBe(true);
    expect(socketA.closes).toEqual([{ code: 1000, reason: 'bye' }]);
  });

  it('converges two clients through the service, starting from the join handshake', async () => {
    const alice = await newUser('Alice');
    const bob = await newUser('Bob');
    const board = await createBoard(database.db, { ownerId: alice.id, title: 'Converge' });
    await addMember(database.db, { boardId: board.id, userId: bob.id, role: 'editor' });

    const aliceSocket = new FakeSocket();
    const bobSocket = new FakeSocket();
    const aliceJoin = await service.open({ user: alice, boardId: board.id, socket: aliceSocket });
    const bobJoin = await service.open({ user: bob, boardId: board.id, socket: bobSocket });
    if (!aliceJoin.ok || !bobJoin.ok) throw new Error('expected both clients to join');

    const aliceDoc = new Y.Doc();
    const bobDoc = new Y.Doc();
    const aliceClient = new SyncClient({ doc: aliceDoc, remoteOrigin: REMOTE_ORIGIN });
    const bobClient = new SyncClient({ doc: bobDoc, remoteOrigin: REMOTE_ORIGIN });

    // Hands each frame the server sent to the client, and sends the client's replies back.
    const deliver = (socket: FakeSocket, client: SyncClient, join: Joined) => {
      while (socket.sent.length > 0) {
        const frame = socket.sent.shift();
        if (!frame) break;
        for (const reply of client.receive(frame)) {
          service.receive(join.connection, reply);
        }
      }
    };

    service.receive(aliceJoin.connection, aliceClient.start());
    service.receive(bobJoin.connection, bobClient.start());
    deliver(aliceSocket, aliceClient, aliceJoin);
    deliver(bobSocket, bobClient, bobJoin);

    // Alice draws; Bob receives it through the service.
    const updates: Uint8Array[] = [];
    const onUpdate = (update: Uint8Array) => updates.push(update);
    aliceDoc.on('update', onUpdate);
    aliceDoc.getMap('objects').set('shape', 'rectangle');
    aliceDoc.off('update', onUpdate);
    for (const update of updates) {
      service.receive(aliceJoin.connection, encodeSyncUpdate(update));
    }
    deliver(bobSocket, bobClient, bobJoin);

    expect(bobDoc.getMap('objects').get('shape')).toBe('rectangle');
    expect(service.roomFor(board.id)?.doc.getMap('objects').get('shape')).toBe('rectangle');
  });

  it('closes a connection that sends an oversized frame, and leaves others open', async () => {
    const owner = await newUser('Oversize');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Oversize' });
    const offender = new FakeSocket();
    const neighbour = new FakeSocket();
    const bad = await service.open({ user: owner, boardId: board.id, socket: offender });
    const good = await service.open({ user: owner, boardId: board.id, socket: neighbour });
    if (!bad.ok || !good.ok) throw new Error('expected both to open');

    service.receive(bad.connection, new Uint8Array(connectionLimits.maxFrameBytes + 1));

    expect(offender.closes[0]?.code).toBe(1009);
    expect(neighbour.closes).toEqual([]);
    expect(service.roomFor(board.id)?.has(good.connection.id)).toBe(true);
  });

  it('removes a connection from its room once its socket is gone', async () => {
    const owner = await newUser('Gone');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Gone' });
    const result = await service.open({ user: owner, boardId: board.id, socket: new FakeSocket() });
    if (!result.ok) throw new Error('expected open');

    result.connection.markClosed();

    expect(service.roomFor(board.id)).toBeUndefined();
  });
});
