import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import {
  MAX_AWARENESS_STATE_BYTES,
  ProtocolError,
  decodeAwarenessEntries,
  decodeClientMessage,
  encodeAwareness,
  encodeAwarenessEntries,
  encodeSyncUpdate,
  type AwarenessEntry,
} from '@inkroom/shared';
import { MemoryBoardStore } from '../persistence/memory-store';
import { MAX_PRESENCE_FRAMES_PER_SECOND, Room, type RoomConnection } from './room';

// Presence is relayed in memory: these tests use several simulated participants in one room and
// check what each one would see, including after unexpected disconnects. Storage is never touched.

const BOARD = 'board-presence';
const LIMITS = {
  maxPayloadBytes: 64 * 1024,
  maxConnectionsPerRoom: 20,
  maxUpdateBytesPerSecond: 1024 * 1024,
};

class FakeConnection implements RoomConnection {
  readonly frames: Uint8Array[] = [];
  alive = true;
  constructor(
    readonly id: string,
    readonly userId: string,
    readonly readOnly = false,
  ) {}
  send(frame: Uint8Array): boolean {
    if (!this.alive) {
      return false;
    }
    this.frames.push(frame);
    return true;
  }
}

const userId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Cursor = { x: number; y: number } | null;

function stateJson(n: number, cursor: Cursor): string {
  return JSON.stringify({
    user: { id: userId(n), name: `User ${n}`, color: '#1971c2' },
    cursor,
    selection: [],
  });
}

// One presence frame from a participant: its id, clock, and a state (or a removal when null).
function presence(clientId: number, clock: number, state: { n: number; cursor: Cursor } | null) {
  const json = state === null ? null : stateJson(state.n, state.cursor);
  return encodeAwareness(encodeAwarenessEntries([{ clientId, clock, json }]));
}

// The awareness entries inside a frame the room sent.
function entriesOf(frame: Uint8Array): AwarenessEntry[] {
  const message = decodeClientMessage(frame, 1024 * 1024);
  if (message.kind !== 'awareness') {
    throw new Error('the frame is not an awareness frame');
  }
  return decodeAwarenessEntries(message.update, MAX_AWARENESS_STATE_BYTES);
}

function awarenessFrames(connection: FakeConnection): Uint8Array[] {
  return connection.frames.filter((frame) => {
    try {
      return decodeClientMessage(frame, 1024 * 1024).kind === 'awareness';
    } catch {
      return false;
    }
  });
}

// The participants a connection would show, built from every awareness frame it was sent.
function viewOf(connection: FakeConnection): Map<number, string> {
  const view = new Map<number, string>();
  for (const frame of awarenessFrames(connection)) {
    for (const entry of entriesOf(frame)) {
      if (entry.json === null) {
        view.delete(entry.clientId);
      } else {
        view.set(entry.clientId, entry.json);
      }
    }
  }
  return view;
}

function makeRoom(now: () => number = () => 0) {
  return new Room({
    boardId: BOARD,
    doc: new Y.Doc(),
    store: new MemoryBoardStore(),
    limits: LIMITS,
    compactEvery: 1000,
    now,
    track: () => undefined,
    presence: { timeoutMs: 30_000, maxEntries: 200 },
  });
}

function connect(room: Room, name: string, n: number): FakeConnection {
  const connection = new FakeConnection(name, userId(n));
  room.join(connection);
  return connection;
}

describe('presence in one room', () => {
  it('relays a cursor to the other participants, but not back to its sender', async () => {
    const room = makeRoom();
    const alice = connect(room, 'alice', 1);
    const bob = connect(room, 'bob', 2);

    await room.receive('alice', presence(101, 1, { n: 1, cursor: { x: 5, y: 6 } }));

    const last = awarenessFrames(bob).at(-1) as Uint8Array;
    expect(entriesOf(last)).toEqual([
      { clientId: 101, clock: 1, json: stateJson(1, { x: 5, y: 6 }) },
    ]);
    expect(awarenessFrames(alice)).toEqual([]);
  });

  it('sends the participants already present to a connection that joins later', async () => {
    const room = makeRoom();
    connect(room, 'alice', 1);
    await room.receive('alice', presence(101, 1, { n: 1, cursor: null }));

    const late = connect(room, 'late', 3);

    expect([...viewOf(late).keys()]).toEqual([101]);
  });

  it('removes a participant for everyone when its connection leaves cleanly', async () => {
    const room = makeRoom();
    connect(room, 'alice', 1);
    const bob = connect(room, 'bob', 2);
    await room.receive('alice', presence(101, 1, { n: 1, cursor: null }));

    room.leave('alice');

    expect(viewOf(bob).has(101)).toBe(false);
  });

  it('removes a participant when its socket breaks mid-session, and tells the others', async () => {
    const room = makeRoom();
    const alice = connect(room, 'alice', 1);
    const bob = connect(room, 'bob', 2);
    const carol = connect(room, 'carol', 3);
    await room.receive('alice', presence(101, 1, { n: 1, cursor: null }));
    expect(viewOf(carol).has(101)).toBe(true);

    // Alice's socket dies without a close. The next relay finds that out and removes her.
    alice.alive = false;
    await room.receive('bob', presence(202, 1, { n: 2, cursor: null }));

    expect(room.has('alice')).toBe(false);
    expect(viewOf(carol).has(101)).toBe(false);
    expect(viewOf(carol).has(202)).toBe(true);
    expect(viewOf(bob).has(101)).toBe(false);
  });

  it('refuses a connection that claims an id held by another connection', async () => {
    const room = makeRoom();
    const alice = connect(room, 'alice', 1);
    const bob = connect(room, 'bob', 2);
    await room.receive('alice', presence(101, 1, { n: 1, cursor: null }));
    const before = awarenessFrames(bob).length;

    await expect(room.receive('bob', presence(101, 9, { n: 2, cursor: null }))).rejects.toThrow(
      /another connection/,
    );

    expect(awarenessFrames(bob).length).toBe(before);
    expect(awarenessFrames(alice)).toEqual([]);
  });

  it('refuses a state that does not match the presence schema, and relays nothing', async () => {
    const room = makeRoom();
    connect(room, 'alice', 1);
    const bob = connect(room, 'bob', 2);

    const offSchema = encodeAwareness(
      encodeAwarenessEntries([
        { clientId: 101, clock: 1, json: JSON.stringify({ cursor: 'nowhere' }) },
      ]),
    );
    const notJson = encodeAwareness(
      encodeAwarenessEntries([{ clientId: 102, clock: 1, json: '{not json' }]),
    );

    await expect(room.receive('alice', offSchema)).rejects.toBeInstanceOf(ProtocolError);
    await expect(room.receive('alice', notJson)).rejects.toBeInstanceOf(ProtocolError);
    expect(awarenessFrames(bob)).toEqual([]);
  });

  it('ignores an older state, so a reordered frame cannot move a cursor back', async () => {
    const room = makeRoom();
    connect(room, 'alice', 1);
    const bob = connect(room, 'bob', 2);

    await room.receive('alice', presence(101, 3, { n: 1, cursor: { x: 30, y: 0 } }));
    await room.receive('alice', presence(101, 2, { n: 1, cursor: { x: 20, y: 0 } }));

    expect(awarenessFrames(bob)).toHaveLength(1);
    expect(viewOf(bob).get(101)).toContain('"x":30');
  });

  it('expires a participant that stops refreshing, and restores it on a later beat', async () => {
    let now = 0;
    const room = makeRoom(() => now);
    connect(room, 'alice', 1);
    const bob = connect(room, 'bob', 2);
    await room.receive('alice', presence(101, 1, { n: 1, cursor: null }));

    now = 31_000;
    room.expirePresence();
    expect(viewOf(bob).has(101)).toBe(false);

    // A frozen tab that resumes sends an old clock: it is ignored, as expired ids are.
    await room.receive('alice', presence(101, 2, { n: 1, cursor: null }));
    expect(viewOf(bob).has(101)).toBe(false);

    // Its next heartbeat has a newer clock, which brings it back.
    await room.receive('alice', presence(101, 3, { n: 1, cursor: null }));
    expect(viewOf(bob).has(101)).toBe(true);
  });

  it('keeps a participant that keeps refreshing', async () => {
    let now = 0;
    const room = makeRoom(() => now);
    connect(room, 'alice', 1);
    const bob = connect(room, 'bob', 2);

    for (let tick = 1; tick <= 4; tick += 1) {
      now = tick * 20_000;
      await room.receive('alice', presence(101, tick, { n: 1, cursor: null }));
      room.expirePresence();
    }

    expect(viewOf(bob).has(101)).toBe(true);
  });

  it('never writes presence to storage or to the document', async () => {
    const store = new MemoryBoardStore();
    const room = new Room({
      boardId: BOARD,
      doc: new Y.Doc(),
      store,
      limits: LIMITS,
      compactEvery: 1000,
      now: () => 0,
      track: () => undefined,
    });
    connect(room, 'alice', 1);
    await room.receive('alice', presence(101, 1, { n: 1, cursor: { x: 1, y: 2 } }));
    room.leave('alice');

    expect(store.updates.get(BOARD)).toBeUndefined();
    expect(room.doc.getMap('objects').size).toBe(0);
  });

  it('limits the presence frames one connection can send per second', async () => {
    const room = makeRoom(() => 500);
    connect(room, 'alice', 1);
    const frame = (index: number) => presence(101, index + 1, { n: 1, cursor: { x: index, y: 0 } });

    for (let index = 0; index < MAX_PRESENCE_FRAMES_PER_SECOND; index += 1) {
      await room.receive('alice', frame(index));
    }
    await expect(room.receive('alice', frame(MAX_PRESENCE_FRAMES_PER_SECOND))).rejects.toThrow(
      /rate limit/,
    );
  });

  it('keeps several simultaneous participants consistent through moves and leaves', async () => {
    const room = makeRoom();
    const names = ['a', 'b', 'c', 'd'];
    const people = names.map((name, index) => connect(room, name, index + 1));
    const ids = [101, 102, 103, 104];

    for (let round = 1; round <= 3; round += 1) {
      for (const [index, name] of names.entries()) {
        const cursor = { x: round * 10, y: index };
        await room.receive(name, presence(ids[index] as number, round, { n: index + 1, cursor }));
      }
    }
    // Each participant sees every other participant's latest state, and not its own.
    for (const [index, person] of people.entries()) {
      const seen = [...viewOf(person).keys()].sort();
      expect(seen).toEqual(ids.filter((_, other) => other !== index));
      for (const id of seen) {
        expect(viewOf(person).get(id)).toContain('"x":30');
      }
    }

    // Two participants disconnect; the remaining two see only each other.
    room.leave('a');
    room.leave('b');
    expect([...viewOf(people[2] as FakeConnection).keys()]).toEqual([104]);
    expect([...viewOf(people[3] as FakeConnection).keys()]).toEqual([103]);

    // A new participant joins and sees exactly the two who are still here.
    const late = connect(room, 'late', 5);
    expect([...viewOf(late).keys()].sort()).toEqual([103, 104]);
  });

  it('keeps the document correct while presence and edits interleave', async () => {
    const room = makeRoom();
    connect(room, 'writer', 1);
    const reader = connect(room, 'reader', 2);
    const client = new Y.Doc();
    const updates: Uint8Array[] = [];
    client.on('update', (update: Uint8Array) => updates.push(update));

    client.getMap('objects').set('shape', 'rect');
    for (const update of updates) {
      await room.receive('writer', presence(101, 1, { n: 1, cursor: { x: 1, y: 1 } }));
      await room.receive('writer', encodeSyncUpdate(update));
    }

    expect(room.doc.getMap('objects').get('shape')).toBe('rect');
    expect(viewOf(reader).has(101)).toBe(true);
  });
});
