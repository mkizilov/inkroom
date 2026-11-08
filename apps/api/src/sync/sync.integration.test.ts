import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  SyncClient,
  decodeClientMessage,
  encodeSyncUpdate,
  type AuthUser,
} from '@inkroom/shared';
import { createBoard, deleteBoard } from '../db/repositories/boards';
import { addMember, removeMember, setMemberRole } from '../db/repositories/memberships';
import { createUser } from '../db/repositories/users';
import {
  createTestDatabase,
  describeWithDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from '../db/test-database';
import { AuthorizationError, PostgresBoardStore } from '../persistence/store';
import { CLOSE_INTERNAL_ERROR, CLOSE_POLICY_VIOLATION, type SocketLike } from './connections';
import {
  BOARD_DELETED_REASON,
  REVOKED_REASON,
  SyncService,
  type Logger,
  type OpenResult,
} from './service';

// These tests do not check sessions, so any session hash will do.
const TEST_SESSION = 'session-hash-for-tests';

// A socket that records what it was sent, so tests can read the frames a client would receive.
class FakeSocket implements SocketLike {
  readonly sent: Uint8Array[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  bufferedAmount = 0;
  readyState: 'open' | 'closed' = 'open';
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  ping(): void {}
  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
    this.readyState = 'closed';
  }
  terminate(): void {
    this.readyState = 'closed';
  }
}

// Updates from the server are applied under this origin, as the browser provider does.
const REMOTE_ORIGIN = Symbol('remote');

type Joined = Extract<OpenResult, { ok: true }>;

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

// A store whose next append can be made to fail, to check that a failed write is not applied.
class FlakyStore extends PostgresBoardStore {
  failNextAppend = false;
  override async appendUpdate(boardId: string, actorId: string, update: Uint8Array) {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error('simulated write failure');
    }
    return super.appendUpdate(boardId, actorId, update);
  }
}

describeWithDatabase('board sync service', () => {
  let database: TestDatabase;
  let store: FlakyStore;
  let service: SyncService;
  const logs: Array<{ level: string; message: string }> = [];
  const logger: Logger = {
    error: (_obj, message) => logs.push({ level: 'error', message }),
    warn: (_obj, message) => logs.push({ level: 'warn', message }),
  };

  const makeService = (activeStore: FlakyStore) =>
    new SyncService({
      db: database.db,
      store: activeStore,
      roomLimits,
      connectionLimits,
      sweepIntervalMs: 0,
      logger,
    });

  beforeAll(async () => {
    database = await createTestDatabase(testDatabaseUrl ?? '');
    store = new FlakyStore(database.db, () => undefined);
    service = makeService(store);
  });

  afterAll(async () => {
    await service.shutdown();
    await database.drop();
  });

  const newUser = async (name: string): Promise<AuthUser> => {
    const user = await createUser(database.db, {
      email: `${randomUUID()}@example.com`,
      displayName: name,
      passwordHash: 'test-hash',
    });
    return { id: user.id, email: user.email, displayName: user.displayName };
  };

  const openAs = (activeService: SyncService, user: AuthUser, boardId: string) =>
    activeService.open({ user, boardId, socket: new FakeSocket(), sessionHash: TEST_SESSION });

  // Hands each frame the server sent to the client, and sends the client's replies back.
  async function pump(
    activeService: SyncService,
    socket: FakeSocket,
    client: SyncClient,
    join: Joined,
  ) {
    while (socket.sent.length > 0) {
      const frame = socket.sent.shift();
      if (!frame) break;
      for (const reply of client.receive(frame)) {
        await activeService.receive(join.connection, reply);
      }
    }
  }

  // Captures the update for one change to a client document.
  function changeFor(doc: Y.Doc, change: (doc: Y.Doc) => void): Uint8Array[] {
    const updates: Uint8Array[] = [];
    const record = (update: Uint8Array) => updates.push(update);
    doc.on('update', record);
    change(doc);
    doc.off('update', record);
    return updates;
  }

  // The roles a client was told about, in order. The server sends one frame per role change.
  function roleFrames(socket: FakeSocket): string[] {
    return socket.sent.flatMap((frame) => {
      const message = decodeClientMessage(frame, 1024);
      return message.kind === 'role' ? [message.role] : [];
    });
  }

  it('admits an owner and a viewer, and marks the viewer read-only', async () => {
    const owner = await newUser('Owner');
    const viewer = await newUser('Viewer');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Shared' });
    await addMember(database.db, { boardId: board.id, userId: viewer.id, role: 'viewer' });

    const ownerResult = await openAs(service, owner, board.id);
    const viewerResult = await openAs(service, viewer, board.id);

    expect(ownerResult.ok && ownerResult.connection.readOnly).toBe(false);
    expect(viewerResult.ok && viewerResult.connection.readOnly).toBe(true);
  });

  it('refuses a non-member with the same answer as a missing board', async () => {
    const owner = await newUser('Owner');
    const stranger = await newUser('Stranger');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Private' });

    const forbidden = await openAs(service, stranger, board.id);
    const missing = await openAs(service, stranger, randomUUID());

    expect(forbidden).toMatchObject({ ok: false, code: CLOSE_POLICY_VIOLATION });
    expect(forbidden).toEqual(missing);
  });

  it('limits how many connections one user can hold, and releases the slot on close', async () => {
    const owner = await newUser('Busy');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Busy board' });

    const first = await openAs(service, owner, board.id);
    await openAs(service, owner, board.id);
    const third = await openAs(service, owner, board.id);
    expect(first.ok).toBe(true);
    expect(third).toMatchObject({ ok: false, reason: 'too many connections' });

    if (first.ok) first.connection.close(1000, 'bye');
    expect((await openAs(service, owner, board.id)).ok).toBe(true);
  });

  it('converges two clients through the service, starting from the join handshake', async () => {
    const alice = await newUser('Alice');
    const bob = await newUser('Bob');
    const board = await createBoard(database.db, { ownerId: alice.id, title: 'Converge' });
    await addMember(database.db, { boardId: board.id, userId: bob.id, role: 'editor' });

    const aliceSocket = new FakeSocket();
    const bobSocket = new FakeSocket();
    const aliceJoin = await service.open({
      user: alice,
      boardId: board.id,
      socket: aliceSocket,
      sessionHash: TEST_SESSION,
    });
    const bobJoin = await service.open({
      user: bob,
      boardId: board.id,
      socket: bobSocket,
      sessionHash: TEST_SESSION,
    });
    if (!aliceJoin.ok || !bobJoin.ok) throw new Error('expected both clients to join');

    const aliceDoc = new Y.Doc();
    const bobDoc = new Y.Doc();
    const aliceClient = new SyncClient({ doc: aliceDoc, remoteOrigin: REMOTE_ORIGIN });
    const bobClient = new SyncClient({ doc: bobDoc, remoteOrigin: REMOTE_ORIGIN });

    await service.receive(aliceJoin.connection, aliceClient.start());
    await service.receive(bobJoin.connection, bobClient.start());
    await pump(service, aliceSocket, aliceClient, aliceJoin);
    await pump(service, bobSocket, bobClient, bobJoin);

    for (const update of changeFor(aliceDoc, (doc) => doc.getMap('objects').set('shape', 'rect'))) {
      await service.receive(aliceJoin.connection, encodeSyncUpdate(update));
    }
    await pump(service, bobSocket, bobClient, bobJoin);

    expect(bobDoc.getMap('objects').get('shape')).toBe('rect');
    expect(service.roomFor(board.id)?.doc.getMap('objects').get('shape')).toBe('rect');
    expect(aliceClient.acknowledgedSeq).toBeGreaterThan(0);
  });

  it('keeps the board across a restart: a new service rebuilds it from the database', async () => {
    const owner = await newUser('Restart');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Restart' });

    const before = makeService(store);
    const socket = new FakeSocket();
    const join = await before.open({
      user: owner,
      boardId: board.id,
      socket,
      sessionHash: TEST_SESSION,
    });
    if (!join.ok) throw new Error('expected the owner to join');
    const client = new SyncClient({ doc: new Y.Doc(), remoteOrigin: REMOTE_ORIGIN });
    await before.receive(join.connection, client.start());
    await pump(before, socket, client, join);
    for (const update of changeFor(client.doc, (doc) => doc.getMap('objects').set('kept', 'yes'))) {
      await before.receive(join.connection, encodeSyncUpdate(update));
    }
    await before.shutdown();

    const after = makeService(store);
    const returning = new FakeSocket();
    const rejoin = await after.open({
      user: owner,
      boardId: board.id,
      socket: returning,
      sessionHash: TEST_SESSION,
    });
    if (!rejoin.ok) throw new Error('expected the owner to rejoin');
    const reader = new SyncClient({ doc: new Y.Doc(), remoteOrigin: REMOTE_ORIGIN });
    await after.receive(rejoin.connection, reader.start());
    await pump(after, returning, reader, rejoin);
    await after.shutdown();

    expect(reader.doc.getMap('objects').get('kept')).toBe('yes');
  });

  it('acknowledges an update only after it is stored', async () => {
    const owner = await newUser('Acks');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Acks' });
    const socket = new FakeSocket();
    const join = await service.open({
      user: owner,
      boardId: board.id,
      socket,
      sessionHash: TEST_SESSION,
    });
    if (!join.ok) throw new Error('expected the owner to join');
    const client = new SyncClient({ doc: new Y.Doc(), remoteOrigin: REMOTE_ORIGIN });
    await service.receive(join.connection, client.start());
    await pump(service, socket, client, join);

    for (const update of changeFor(client.doc, (doc) => doc.getMap('objects').set('a', 1))) {
      await service.receive(join.connection, encodeSyncUpdate(update));
    }
    await pump(service, socket, client, join);

    expect(client.acknowledgedSeq).toBeGreaterThan(0);
  });

  it('closes only the sender when a write fails, and applies nothing for it', async () => {
    const owner = await newUser('Failing');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Failing' });
    const senderSocket = new FakeSocket();
    const neighbourSocket = new FakeSocket();
    const sender = await service.open({
      user: owner,
      boardId: board.id,
      socket: senderSocket,
      sessionHash: TEST_SESSION,
    });
    const neighbour = await service.open({
      user: owner,
      boardId: board.id,
      socket: neighbourSocket,
      sessionHash: TEST_SESSION,
    });
    if (!sender.ok || !neighbour.ok) throw new Error('expected both to join');

    const client = new SyncClient({ doc: new Y.Doc(), remoteOrigin: REMOTE_ORIGIN });
    const updates = changeFor(client.doc, (doc) => doc.getMap('objects').set('lost', 1));
    store.failNextAppend = true;
    const framesBefore = neighbourSocket.sent.length;
    for (const update of updates) {
      await service.receive(sender.connection, encodeSyncUpdate(update));
    }

    expect(senderSocket.closes[0]?.code).toBe(CLOSE_INTERNAL_ERROR);
    expect(neighbourSocket.closes).toEqual([]);
    expect(neighbourSocket.sent.length).toBe(framesBefore);
    expect(service.roomFor(board.id)?.doc.getMap('objects').has('lost')).toBe(false);
    expect(logs.some((entry) => entry.message === 'sync update was not stored')).toBe(true);
  });

  it('closes a connection that sends an oversized frame, leaving its neighbours open', async () => {
    const owner = await newUser('Oversize');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Oversize' });
    const offender = new FakeSocket();
    const neighbour = new FakeSocket();
    const bad = await service.open({
      user: owner,
      boardId: board.id,
      socket: offender,
      sessionHash: TEST_SESSION,
    });
    const good = await service.open({
      user: owner,
      boardId: board.id,
      socket: neighbour,
      sessionHash: TEST_SESSION,
    });
    if (!bad.ok || !good.ok) throw new Error('expected both to open');

    await service.receive(bad.connection, new Uint8Array(connectionLimits.maxFrameBytes + 1));

    expect(offender.closes[0]?.code).toBe(1009);
    expect(neighbour.closes).toEqual([]);
    expect(service.roomFor(board.id)?.has(good.connection.id)).toBe(true);
  });

  it('releases the room when its last socket is gone', async () => {
    const owner = await newUser('Gone');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Gone' });
    const result = await openAs(service, owner, board.id);
    if (!result.ok) throw new Error('expected open');

    result.connection.markClosed();

    expect(service.roomFor(board.id)).toBeUndefined();
  });

  it('applies a role change to an open connection at once, and tells the client', async () => {
    const owner = await newUser('Demoting owner');
    const editor = await newUser('Demoted');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Demotion' });
    await addMember(database.db, { boardId: board.id, userId: editor.id, role: 'editor' });
    const socket = new FakeSocket();
    const join = await service.open({
      user: editor,
      boardId: board.id,
      socket,
      sessionHash: TEST_SESSION,
    });
    if (!join.ok) throw new Error('expected the editor to join');

    await setMemberRole(database.db, { boardId: board.id, userId: editor.id, role: 'viewer' });
    service.applyMembership(board.id, editor.id, 'viewer');
    const client = new Y.Doc();
    client.getMap('objects').set('demoted', 1);
    await service.receive(join.connection, encodeSyncUpdate(Y.encodeStateAsUpdate(client)));

    expect(join.connection.readOnly).toBe(true);
    expect(roleFrames(socket)).toEqual(['viewer']);
    expect(socket.closes).toEqual([]);
    expect((await store.load(board.id)).getMap('objects').has('demoted')).toBe(false);
  });

  it('disconnects a removed member at once, with the revoked reason', async () => {
    const owner = await newUser('Removing owner');
    const member = await newUser('Removed member');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Removal' });
    await addMember(database.db, { boardId: board.id, userId: member.id, role: 'viewer' });
    const socket = new FakeSocket();
    const join = await service.open({
      user: member,
      boardId: board.id,
      socket,
      sessionHash: TEST_SESSION,
    });
    if (!join.ok) throw new Error('expected the member to join');

    await removeMember(database.db, { boardId: board.id, userId: member.id });
    service.applyMembership(board.id, member.id, null);

    expect(socket.closes).toEqual([{ code: CLOSE_POLICY_VIOLATION, reason: REVOKED_REASON }]);
    expect(join.connection.isClosed).toBe(true);
  });

  it('catches changes made by another process at the next membership check', async () => {
    const owner = await newUser('Checked owner');
    const editor = await newUser('Checked editor');
    const leaver = await newUser('Checked leaver');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Checked' });
    await addMember(database.db, { boardId: board.id, userId: editor.id, role: 'editor' });
    await addMember(database.db, { boardId: board.id, userId: leaver.id, role: 'viewer' });
    const editorSocket = new FakeSocket();
    const leaverSocket = new FakeSocket();
    const editorJoin = await service.open({
      user: editor,
      boardId: board.id,
      socket: editorSocket,
      sessionHash: TEST_SESSION,
    });
    const leaverJoin = await service.open({
      user: leaver,
      boardId: board.id,
      socket: leaverSocket,
      sessionHash: TEST_SESSION,
    });
    if (!editorJoin.ok || !leaverJoin.ok) throw new Error('expected both to join');

    // This process is told of neither change, so only the membership check can find them.
    await setMemberRole(database.db, { boardId: board.id, userId: editor.id, role: 'viewer' });
    await removeMember(database.db, { boardId: board.id, userId: leaver.id });
    await service.reconcileMemberships();

    expect(editorJoin.connection.readOnly).toBe(true);
    expect(roleFrames(editorSocket)).toEqual(['viewer']);
    expect(leaverSocket.closes).toEqual([{ code: CLOSE_POLICY_VIOLATION, reason: REVOKED_REASON }]);
  });

  it('disconnects everyone on a board when it is deleted', async () => {
    const owner = await newUser('Deleting owner');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Doomed' });
    const socket = new FakeSocket();
    const join = await service.open({
      user: owner,
      boardId: board.id,
      socket,
      sessionHash: TEST_SESSION,
    });
    if (!join.ok) throw new Error('expected the owner to join');

    await deleteBoard(database.db, board.id);
    service.boardDeleted(board.id);

    expect(socket.closes).toEqual([{ code: CLOSE_POLICY_VIOLATION, reason: BOARD_DELETED_REASON }]);
  });

  it('makes the database refuse writes and restores from anyone without the role', async () => {
    const owner = await newUser('Guarded owner');
    const viewer = await newUser('Guarded viewer');
    const editor = await newUser('Guarded editor');
    const stranger = await newUser('Guarded stranger');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Guarded' });
    await addMember(database.db, { boardId: board.id, userId: viewer.id, role: 'viewer' });
    await addMember(database.db, { boardId: board.id, userId: editor.id, role: 'editor' });
    const change = new Y.Doc();
    change.getMap('objects').set('guarded', 1);
    const update = Y.encodeStateAsUpdate(change);

    await expect(store.appendUpdate(board.id, viewer.id, update)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(store.appendUpdate(board.id, stranger.id, update)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(store.restore(board.id, 1, editor.id)).rejects.toBeInstanceOf(AuthorizationError);
    expect((await store.load(board.id)).getMap('objects').has('guarded')).toBe(false);

    await store.appendUpdate(board.id, editor.id, update);
    expect((await store.load(board.id)).getMap('objects').has('guarded')).toBe(true);
  });

  it('closes an editor whose write the database refuses after its access was removed elsewhere', async () => {
    const owner = await newUser('Stale owner');
    const editor = await newUser('Stale editor');
    const board = await createBoard(database.db, { ownerId: owner.id, title: 'Stale' });
    await addMember(database.db, { boardId: board.id, userId: editor.id, role: 'editor' });
    const socket = new FakeSocket();
    const join = await service.open({
      user: editor,
      boardId: board.id,
      socket,
      sessionHash: TEST_SESSION,
    });
    if (!join.ok) throw new Error('expected the editor to join');

    // The room still holds the editor's old role, so only the database check can refuse this write.
    await removeMember(database.db, { boardId: board.id, userId: editor.id });
    const change = new Y.Doc();
    change.getMap('objects').set('stale', 1);
    await service.receive(join.connection, encodeSyncUpdate(Y.encodeStateAsUpdate(change)));

    expect(socket.closes).toEqual([
      { code: CLOSE_POLICY_VIOLATION, reason: 'not permitted to change this board' },
    ]);
    expect((await store.load(board.id)).getMap('objects').has('stale')).toBe(false);
  });
});
