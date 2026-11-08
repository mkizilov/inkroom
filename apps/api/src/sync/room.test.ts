import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import {
  ProtocolError,
  SyncClient,
  encodeAck,
  encodeAwareness,
  encodeSyncUpdate,
  readOrderedObjects,
} from '@inkroom/shared';
import { MemoryBoardStore } from '../persistence/memory-store';
import {
  Room,
  awarenessRemoval,
  readAwareness,
  type RoomConnection,
  type RoomLimits,
} from './room';

// Simulated clients, each with its own Y.Doc, connected to one Room through in-memory connections.
// The store is in memory, so these tests cover the room's protocol and durability rules without a
// database. Persistence against PostgreSQL is covered by the integration tests.

const LIMITS: RoomLimits = {
  maxPayloadBytes: 64 * 1024,
  maxConnectionsPerRoom: 10,
  maxUpdateBytesPerSecond: 1024 * 1024,
};
const BOARD = 'board-1';
const REMOTE = Symbol('remote');

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

type RoomOverrides = Partial<ConstructorParameters<typeof Room>[0]>;

function makeRoom(store: MemoryBoardStore, overrides: RoomOverrides = {}) {
  const doc = new Y.Doc();
  return new Room({
    boardId: BOARD,
    doc,
    store,
    limits: LIMITS,
    compactEvery: 1_000,
    now: () => 0,
    track: () => undefined,
    ...overrides,
  });
}

// One simulated browser: a client document, a sync client, and its connection to the room.
class Peer {
  readonly doc = new Y.Doc();
  readonly sync = new SyncClient({ doc: this.doc, remoteOrigin: REMOTE });
  readonly connection: FakeConnection;

  constructor(
    readonly name: string,
    readonly room: Room,
    readOnly = false,
  ) {
    this.connection = new FakeConnection(name, name, readOnly);
  }

  async connect(): Promise<void> {
    this.room.join(this.connection);
    await this.send(this.sync.start());
  }

  // Sends a frame to the room, then hands everything the room sent back to the sync client.
  async send(frame: Uint8Array): Promise<void> {
    await this.room.receive(this.name, frame);
    await this.deliver();
  }

  async deliver(): Promise<void> {
    while (this.connection.frames.length > 0) {
      const frame = this.connection.frames.shift();
      if (!frame) break;
      for (const reply of this.sync.receive(frame)) {
        await this.room.receive(this.name, reply);
      }
    }
  }

  // A local edit, sent to the room as an update frame.
  async edit(change: (doc: Y.Doc) => void): Promise<void> {
    for (const update of captureUpdates(this.doc, change)) {
      await this.send(encodeSyncUpdate(update));
    }
  }

  objectIds(): string[] {
    return ids(this.doc);
  }
}

function captureUpdates(doc: Y.Doc, change: (doc: Y.Doc) => void): Uint8Array[] {
  const updates: Uint8Array[] = [];
  const record = (update: Uint8Array) => updates.push(update);
  doc.on('update', record);
  doc.transact(() => change(doc));
  doc.off('update', record);
  return updates;
}

async function settle(...peers: Peer[]): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    for (const peer of peers) {
      await peer.deliver();
    }
  }
}

async function connectAll(room: Room, names: string[], readOnly: string[] = []): Promise<Peer[]> {
  const peers = names.map((name) => new Peer(name, room, readOnly.includes(name)));
  for (const peer of peers) {
    await peer.connect();
  }
  await settle(...peers);
  return peers;
}

function textObject(id: string, text: string): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set('id', id);
  map.set('type', 'text');
  map.set('x', 0);
  map.set('y', 0);
  map.set('stroke', '#000000');
  map.set('strokeWidth', 2);
  map.set('fontSize', 24);
  const content = new Y.Text();
  content.insert(0, text);
  map.set('text', content);
  return map;
}

function ids(doc: Y.Doc): string[] {
  return [...doc.getMap<Y.Map<unknown>>('objects').keys()].sort();
}

function textOf(doc: Y.Doc, id: string): string | undefined {
  return doc.getMap<Y.Map<unknown>>('objects').get(id)?.get('text')?.toString();
}

// The bytes of the Yjs update produced by one change to a fresh document.
function updateOf(change: (doc: Y.Doc) => void): Uint8Array {
  return Y.mergeUpdates(captureUpdates(new Y.Doc(), change));
}

describe('two or more simulated clients in one room', () => {
  it('synchronise the initial state to a client that joins later', async () => {
    const store = new MemoryBoardStore();
    const room = makeRoom(store);
    const [first] = await connectAll(room, ['first']);
    await first?.edit((doc) => doc.getMap('objects').set('a', textObject('a', 'hello')));

    const [late] = await connectAll(room, ['late']);

    expect(late?.objectIds()).toEqual(['a']);
    expect(textOf(late?.doc as Y.Doc, 'a')).toBe('hello');
  });

  it('broadcast a drawn object to the other client', async () => {
    const room = makeRoom(new MemoryBoardStore());
    const [alice, bob] = await connectAll(room, ['alice', 'bob']);

    await alice?.edit((doc) => doc.getMap('objects').set('rect', textObject('rect', 'box')));
    await settle(alice as Peer, bob as Peer);

    expect(bob?.objectIds()).toEqual(['rect']);
    expect(alice?.objectIds()).toEqual(['rect']);
  });

  it('broadcast moves and deletions, and keep both documents equal', async () => {
    const room = makeRoom(new MemoryBoardStore());
    const [alice, bob] = await connectAll(room, ['alice', 'bob']);
    await alice?.edit((doc) => {
      doc.getMap('objects').set('a', textObject('a', 'one'));
      doc.getMap('objects').set('b', textObject('b', 'two'));
    });

    await settle(alice as Peer, bob as Peer);
    await bob?.edit((doc) => doc.getMap<Y.Map<unknown>>('objects').get('a')?.set('x', 120));
    await alice?.edit((doc) => doc.getMap('objects').delete('b'));
    await settle(alice as Peer, bob as Peer);

    expect(bob?.objectIds()).toEqual(['a']);
    expect(alice?.doc.getMap<Y.Map<unknown>>('objects').get('a')?.get('x')).toBe(120);
    expect(Y.encodeStateVector(alice?.doc as Y.Doc)).toEqual(
      Y.encodeStateVector(bob?.doc as Y.Doc),
    );
  });

  it('merge concurrent text edits from both clients', async () => {
    const room = makeRoom(new MemoryBoardStore());
    const [alice, bob] = await connectAll(room, ['alice', 'bob']);
    await alice?.edit((doc) => doc.getMap('objects').set('t', textObject('t', 'one two')));
    await settle(alice as Peer, bob as Peer);

    const aliceUpdates = captureUpdates(alice?.doc as Y.Doc, (doc) => {
      (doc.getMap<Y.Map<unknown>>('objects').get('t')?.get('text') as Y.Text).insert(0, 'A ');
    });
    const bobUpdates = captureUpdates(bob?.doc as Y.Doc, (doc) => {
      const text = doc.getMap<Y.Map<unknown>>('objects').get('t')?.get('text') as Y.Text;
      text.insert(text.length, ' Z');
    });
    for (const update of aliceUpdates) await alice?.send(encodeSyncUpdate(update));
    for (const update of bobUpdates) await bob?.send(encodeSyncUpdate(update));
    await settle(alice as Peer, bob as Peer);

    expect(textOf(alice?.doc as Y.Doc, 't')).toBe(textOf(bob?.doc as Y.Doc, 't'));
    expect(textOf(alice?.doc as Y.Doc, 't')).toContain('A ');
    expect(textOf(alice?.doc as Y.Doc, 't')).toContain(' Z');
  });

  it('keep two clients in step through many interleaved edits', async () => {
    const room = makeRoom(new MemoryBoardStore());
    const [alice, bob] = await connectAll(room, ['alice', 'bob']);
    const peers = [alice as Peer, bob as Peer];

    for (let step = 0; step < 40; step += 1) {
      const actor = peers[step % 2] as Peer;
      await actor.edit((doc) => {
        const objects = doc.getMap<Y.Map<unknown>>('objects');
        const [victim] = [...objects.keys()].sort();
        if (step % 3 === 2 && victim) {
          objects.delete(victim);
        } else {
          objects.set(`obj-${step}`, textObject(`obj-${step}`, `note ${step}`));
        }
      });
      await settle(...peers);
    }

    expect(alice?.objectIds()).toEqual(bob?.objectIds());
    expect((alice?.objectIds() ?? []).length).toBeGreaterThan(0);
  });

  it('let a client that reconnects catch up on what it missed', async () => {
    const room = makeRoom(new MemoryBoardStore());
    const [alice, bob] = await connectAll(room, ['alice', 'bob']);
    await alice?.edit((doc) => doc.getMap('objects').set('before', textObject('before', 'x')));
    await settle(alice as Peer, bob as Peer);

    room.leave('bob');
    await alice?.edit((doc) => doc.getMap('objects').set('during', textObject('during', 'y')));

    const returning = new Peer('bob', room);
    returning.doc.getMap('objects').set('offline', textObject('offline', 'z'));
    await returning.connect();
    await settle(alice as Peer, returning);

    expect(returning.objectIds()).toEqual(['before', 'during', 'offline']);
    expect(alice?.objectIds()).toEqual(['before', 'during', 'offline']);
  });
});

describe('durability', () => {
  it('stores each client update before any other client sees it', async () => {
    const store = new MemoryBoardStore();
    const room = makeRoom(store);
    const [alice, bob] = await connectAll(room, ['alice', 'bob']);

    await alice?.edit((doc) => doc.getMap('objects').set('a', textObject('a', 'stored')));

    expect(store.updates.get(BOARD)?.length ?? 0).toBeGreaterThan(0);
    expect(bob?.objectIds()).toEqual(['a']);
  });

  it('acknowledges a stored update to its sender with the stored sequence number', async () => {
    const store = new MemoryBoardStore();
    const room = makeRoom(store);
    const [alice] = await connectAll(room, ['alice']);

    await alice?.edit((doc) => doc.getMap('objects').set('a', textObject('a', 'x')));

    expect(alice?.sync.acknowledgedSeq).toBeGreaterThan(0);
    expect(alice?.sync.acknowledgedSeq).toBe(store.updates.get(BOARD)?.at(-1)?.seq);
  });

  it('applies, broadcasts and acknowledges nothing when the write fails', async () => {
    const store = new MemoryBoardStore();
    const room = makeRoom(store);
    const [alice, bob] = await connectAll(room, ['alice', 'bob']);
    const framesBefore = bob?.connection.frames.length ?? 0;
    store.failNextAppends = 1;

    const update = updateOf((doc) => doc.getMap('objects').set('lost', textObject('lost', 'x')));
    await expect(room.receive('alice', encodeSyncUpdate(update))).rejects.toThrow(/simulated/);

    expect(room.doc.getMap('objects').has('lost')).toBe(false);
    expect(bob?.connection.frames.length ?? 0).toBe(framesBefore);
    expect(alice?.sync.acknowledgedSeq).toBe(0);
  });

  it('accepts the same update when the client sends it again after a failed write', async () => {
    const store = new MemoryBoardStore();
    const room = makeRoom(store);
    const [alice] = await connectAll(room, ['alice']);
    store.failNextAppends = 1;
    const update = updateOf((doc) => doc.getMap('objects').set('retry', textObject('retry', 'x')));

    await expect(room.receive('alice', encodeSyncUpdate(update))).rejects.toThrow();
    await room.receive('alice', encodeSyncUpdate(update));

    expect(room.doc.getMap('objects').has('retry')).toBe(true);
    expect(alice?.sync.acknowledgedSeq).toBeGreaterThan(0);
  });

  it('rebuilds the same document from the stored log after the room is released', async () => {
    const store = new MemoryBoardStore();
    const first = makeRoom(store);
    const [alice] = await connectAll(first, ['alice']);
    await alice?.edit((doc) => doc.getMap('objects').set('kept', textObject('kept', 'persisted')));
    await alice?.edit((doc) => doc.getMap('objects').set('second', textObject('second', 'too')));
    first.destroy();

    const restarted = makeRoom(store, { doc: await store.load(BOARD) });
    const [bob] = await connectAll(restarted, ['bob']);

    expect(bob?.objectIds()).toEqual(['kept', 'second']);
    expect(textOf(bob?.doc as Y.Doc, 'kept')).toBe('persisted');
  });

  it('does not store an update that changes nothing', async () => {
    const store = new MemoryBoardStore();
    const room = makeRoom(store);
    await connectAll(room, ['alice']);

    await room.receive('alice', encodeSyncUpdate(new Uint8Array([0, 0])));

    expect(store.updates.get(BOARD)).toBeUndefined();
  });

  it('does not write a change applied as a restore, and tells the connected clients', async () => {
    const store = new MemoryBoardStore();
    const room = makeRoom(store);
    const [bob] = await connectAll(room, ['bob']);
    const restored = updateOf((doc) =>
      doc.getMap('objects').set('restored', textObject('r', 'back')),
    );

    await room.applyPersisted(restored);
    await settle(bob as Peer);

    expect(store.updates.get(BOARD)).toBeUndefined();
    expect(bob?.objectIds()).toEqual(['restored']);
  });

  it('asks the store to compact after the configured number of stored updates', async () => {
    const work: Promise<unknown>[] = [];
    const store = new MemoryBoardStore();
    let compactions = 0;
    store.compact = async () => {
      compactions += 1;
      return null;
    };
    const room = makeRoom(store, { compactEvery: 3, track: (promise) => work.push(promise) });
    const [alice] = await connectAll(room, ['alice']);

    for (let index = 0; index < 3; index += 1) {
      await alice?.edit((doc) =>
        doc.getMap('objects').set(`n${index}`, textObject(`n${index}`, 'x')),
      );
    }
    await Promise.all(work);

    expect(compactions).toBe(1);
  });
});

describe('read-only connections', () => {
  it('receive the document and cannot change it', async () => {
    const store = new MemoryBoardStore();
    const room = makeRoom(store);
    const [editor, viewer] = await connectAll(room, ['editor', 'viewer'], ['viewer']);
    await editor?.edit((doc) => doc.getMap('objects').set('a', textObject('a', 'shared')));
    await settle(editor as Peer, viewer as Peer);
    expect(viewer?.objectIds()).toEqual(['a']);

    // The viewer's own copy keeps the local edit, since nothing reverts it on the client. The room
    // and the other editors must not see it, and nothing may be stored. See docs/sync.md.
    await viewer?.edit((doc) => doc.getMap('objects').set('viewer-only', textObject('v', 'nope')));
    await settle(editor as Peer, viewer as Peer);

    expect(ids(room.doc)).toEqual(['a']);
    expect(editor?.objectIds()).toEqual(['a']);
    expect(store.updates.get(BOARD)?.length).toBe(1);
  });

  it('keep the viewer connected after its writes are dropped', async () => {
    const room = makeRoom(new MemoryBoardStore());
    const [, viewer] = await connectAll(room, ['editor', 'viewer'], ['viewer']);
    await viewer?.edit((doc) => doc.getMap('objects').set('nope', textObject('n', 'x')));

    expect(room.has('viewer')).toBe(true);
  });
});

describe('frame and resource limits', () => {
  it('rejects a frame larger than the payload limit before decoding it', async () => {
    const room = makeRoom(new MemoryBoardStore());
    room.join(new FakeConnection('a', 'a'));
    const huge = encodeSyncUpdate(new Uint8Array(LIMITS.maxPayloadBytes + 1));

    await expect(room.receive('a', huge)).rejects.toThrow(/exceeds|limit/);
  });

  it('rejects a malformed frame with a protocol error', async () => {
    const room = makeRoom(new MemoryBoardStore());
    room.join(new FakeConnection('a', 'a'));

    await expect(room.receive('a', new Uint8Array([9, 9, 9]))).rejects.toThrow(ProtocolError);
  });

  it('refuses an update whose structure is invalid, and stores nothing', async () => {
    const store = new MemoryBoardStore();
    const room = makeRoom(store);
    room.join(new FakeConnection('a', 'a'));

    await expect(
      room.receive('a', encodeSyncUpdate(new Uint8Array([0xff, 0xff, 0xff]))),
    ).rejects.toThrow(ProtocolError);
    expect(store.updates.get(BOARD)).toBeUndefined();
  });

  it('refuses a client that tries to send an acknowledgement', async () => {
    const room = makeRoom(new MemoryBoardStore());
    room.join(new FakeConnection('a', 'a'));

    await expect(room.receive('a', encodeAck(5))).rejects.toThrow(/acknowledgements/);
  });

  it('enforces the update rate per connection, not per room', async () => {
    const now = { value: 0 };
    const store = new MemoryBoardStore();
    const room = makeRoom(store, {
      limits: { ...LIMITS, maxUpdateBytesPerSecond: 100 },
      now: () => now.value,
    });
    room.join(new FakeConnection('spammer', 'spammer'));
    room.join(new FakeConnection('quiet', 'quiet'));

    const big = updateOf((doc) => doc.getMap('objects').set('k', 'x'.repeat(200)));
    const small = updateOf((doc) => doc.getMap('objects').set('n', 1));
    expect(small.byteLength).toBeLessThan(100);

    await expect(room.receive('spammer', encodeSyncUpdate(big))).rejects.toThrow(/rate limit/);
    await expect(room.receive('quiet', encodeSyncUpdate(small))).resolves.toBeUndefined();

    now.value = 1500;
    await expect(room.receive('spammer', encodeSyncUpdate(small))).resolves.toBeUndefined();
  });

  it('refuses new connections once the room is full', () => {
    const room = makeRoom(new MemoryBoardStore(), {
      limits: { ...LIMITS, maxConnectionsPerRoom: 2 },
    });

    expect(room.join(new FakeConnection('a', 'a')).ok).toBe(true);
    expect(room.join(new FakeConnection('b', 'b')).ok).toBe(true);
    expect(room.join(new FakeConnection('c', 'c'))).toEqual({ ok: false, reason: 'full' });
  });

  it('refuses joins after the room has ended', () => {
    const room = makeRoom(new MemoryBoardStore());
    room.destroy();

    expect(room.join(new FakeConnection('a', 'a'))).toEqual({ ok: false, reason: 'closed' });
  });

  it('drops a connection whose socket cannot take frames, leaving the others', async () => {
    const room = makeRoom(new MemoryBoardStore());
    const healthy = new FakeConnection('healthy', 'healthy');
    const broken = new FakeConnection('broken', 'broken');
    const sender = new FakeConnection('sender', 'sender');
    room.join(healthy);
    room.join(broken);
    room.join(sender);
    broken.alive = false;

    const update = updateOf((doc) => doc.getMap('objects').set('k', 'v'));
    await room.receive('sender', encodeSyncUpdate(update));

    expect(room.has('broken')).toBe(false);
    expect(room.has('healthy')).toBe(true);
    expect(healthy.frames.length).toBeGreaterThan(0);
  });
});

describe('awareness and presence', () => {
  it('reads client ids and clocks from an awareness payload', () => {
    const payload = awarenessRemoval([
      { clientId: 7, clock: 3 },
      { clientId: 9, clock: 1 },
    ]);
    expect(readAwareness(payload)).toEqual([
      { clientId: 7, clock: 3 },
      { clientId: 9, clock: 1 },
    ]);
  });

  it('returns no entries for an unreadable awareness payload', () => {
    expect(readAwareness(new Uint8Array([0xff]))).toEqual([]);
  });

  it('relays presence updates to other clients', async () => {
    const room = makeRoom(new MemoryBoardStore());
    const [alice, bob] = await connectAll(room, ['alice', 'bob']);
    const presence = awarenessRemoval([{ clientId: 42, clock: 1 }]);

    await alice?.send(encodeAwareness(presence));

    expect(bob?.connection.frames.length).toBeGreaterThan(0);
  });

  it('announces a departed client as gone, with a clock newer than its last update', async () => {
    const room = makeRoom(new MemoryBoardStore());
    const [alice, bob] = await connectAll(room, ['alice', 'bob']);
    await alice?.send(encodeAwareness(awarenessRemoval([{ clientId: 42, clock: 5 }])));
    bob?.connection.frames.splice(0);

    room.leave('alice');

    const removal = bob?.connection.frames.at(-1);
    expect(removal).toBeDefined();
    expect(removal && readAwareness(removal.subarray(2))).toEqual([{ clientId: 42, clock: 6 }]);
  });
});

describe('room lifecycle and recovery', () => {
  it('reports the number of connections it holds', () => {
    const room = makeRoom(new MemoryBoardStore());
    room.join(new FakeConnection('a', 'a'));
    room.join(new FakeConnection('b', 'b'));
    room.leave('a');

    expect(room.size).toBe(1);
  });

  it('ignores frames from a connection that has left', async () => {
    const room = makeRoom(new MemoryBoardStore());
    room.join(new FakeConnection('a', 'a'));
    room.leave('a');

    await expect(room.receive('a', encodeSyncUpdate(new Uint8Array(0)))).rejects.toThrow(
      /not in this room/,
    );
  });

  it('rebuilds typed objects in z-order from the stored log', async () => {
    const store = new MemoryBoardStore();
    const room = makeRoom(store);
    const [alice] = await connectAll(room, ['alice']);
    await alice?.edit((doc) => doc.getMap('objects').set('a', textObject('a', 'first')));
    await alice?.edit((doc) => doc.getMap('objects').set('b', textObject('b', 'second')));

    const rebuilt = readOrderedObjects(
      (await store.load(BOARD)).getMap<Y.Map<unknown>>('objects'),
    ).objects;

    expect(rebuilt.map((object) => object.id)).toEqual(['a', 'b']);
  });
});
