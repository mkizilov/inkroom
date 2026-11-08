import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { ProtocolError, SyncClient, encodeAwareness, encodeSyncUpdate } from '@inkroom/shared';
import {
  Room,
  awarenessRemoval,
  readAwareness,
  type RoomConnection,
  type RoomLimits,
} from './room';

// Two or more simulated clients, each with its own Y.Doc, talk to one Room through in-memory
// connections. Frames are delivered synchronously, so a test can check the state after each step.

const LIMITS: RoomLimits = {
  maxPayloadBytes: 64 * 1024,
  maxConnectionsPerRoom: 10,
  maxUpdateBytesPerSecond: 1024 * 1024,
};

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

// One simulated browser: a client document, a sync client, and the connection to the room.
class Peer {
  readonly doc = new Y.Doc();
  readonly sync = new SyncClient({ doc: this.doc, remoteOrigin: REMOTE });
  readonly connection: FakeConnection;
  readonly inbox: Uint8Array[] = [];

  constructor(
    readonly name: string,
    readonly room: Room,
    readOnly = false,
  ) {
    this.connection = new FakeConnection(name, name, readOnly);
  }

  connect(): void {
    this.room.join(this.connection);
    this.sendFrame(this.sync.start());
    this.pump();
  }

  // Delivers everything the room has sent this peer to the peer's sync client, and sends replies.
  pump(): void {
    while (this.connection.frames.length > 0) {
      const frame = this.connection.frames.shift();
      if (!frame) {
        break;
      }
      for (const reply of this.sync.receive(frame)) {
        this.sendFrame(reply);
      }
    }
  }

  sendFrame(frame: Uint8Array): void {
    this.room.receive(this.name, frame);
  }

  // A local edit: apply it to this peer's document and send the resulting update to the room.
  edit(change: (doc: Y.Doc) => void): void {
    const updates: Uint8Array[] = [];
    const handler = (update: Uint8Array) => updates.push(update);
    this.doc.on('update', handler);
    this.doc.transact(() => change(this.doc));
    this.doc.off('update', handler);
    for (const update of updates) {
      this.sendFrame(encodeSyncUpdate(update));
    }
  }

  // Delivers room frames to this peer, then lets the room catch up with any replies.
  deliver(): void {
    this.pump();
  }
}

// Relays are delivered when a peer is pumped. These helpers run pumps until nothing is pending.
function settle(...peers: Peer[]): void {
  for (let round = 0; round < 10; round += 1) {
    for (const peer of peers) {
      peer.deliver();
    }
  }
}

function connectAll(room: Room, names: string[], readOnly: string[] = []): Peer[] {
  const peers = names.map((name) => new Peer(name, room, readOnly.includes(name)));
  for (const peer of peers) {
    peer.connect();
  }
  settle(...peers);
  return peers;
}

function textObject(id: string, text: string): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set('type', 'text');
  map.set('x', 0);
  map.set('y', 0);
  map.set('stroke', '#000000');
  map.set('strokeWidth', 2);
  map.set('fontSize', 24);
  const content = new Y.Text();
  content.insert(0, text);
  map.set('text', content);
  map.set('id', id);
  return map;
}

function objectIds(doc: Y.Doc): string[] {
  return [...doc.getMap<Y.Map<unknown>>('objects').keys()].sort();
}

describe('two simulated clients in one room', () => {
  it('synchronise the initial state to a client that joins later', () => {
    const room = new Room('board-1', LIMITS);
    const [first] = connectAll(room, ['first']);
    first?.edit((doc) => doc.getMap('objects').set('a', textObject('a', 'hello')));

    const [late] = connectAll(room, ['late']);

    expect(late?.doc.getMap('objects').has('a')).toBe(true);
    expect(late?.doc.getMap<Y.Map<unknown>>('objects').get('a')?.get('text')?.toString()).toBe(
      'hello',
    );
  });

  it('broadcast a drawn object to the other client', () => {
    const room = new Room('board-1', LIMITS);
    const [alice, bob] = connectAll(room, ['alice', 'bob']);

    alice?.edit((doc) => doc.getMap('objects').set('rect', textObject('rect', 'box')));
    settle(alice as Peer, bob as Peer);

    expect(objectIds(bob?.doc as Y.Doc)).toEqual(['rect']);
    expect(objectIds(alice?.doc as Y.Doc)).toEqual(['rect']);
  });

  it('broadcast moves and deletions, and keep both documents equal', () => {
    const room = new Room('board-1', LIMITS);
    const [alice, bob] = connectAll(room, ['alice', 'bob']);
    alice?.edit((doc) => {
      doc.getMap('objects').set('a', textObject('a', 'one'));
      doc.getMap('objects').set('b', textObject('b', 'two'));
    });
    settle(alice as Peer, bob as Peer);

    bob?.edit((doc) => {
      doc.getMap<Y.Map<unknown>>('objects').get('a')?.set('x', 120);
    });
    settle(alice as Peer, bob as Peer);
    expect(alice?.doc.getMap<Y.Map<unknown>>('objects').get('a')?.get('x')).toBe(120);

    alice?.edit((doc) => doc.getMap('objects').delete('b'));
    settle(alice as Peer, bob as Peer);

    expect(objectIds(bob?.doc as Y.Doc)).toEqual(['a']);
    expect(bob?.doc.getMap<Y.Map<unknown>>('objects').get('a')?.get('x')).toBe(120);
    expect(Y.encodeStateVector(alice?.doc as Y.Doc)).toEqual(
      Y.encodeStateVector(bob?.doc as Y.Doc),
    );
  });

  it('merge concurrent text edits from both clients', () => {
    const room = new Room('board-1', LIMITS);
    const [alice, bob] = connectAll(room, ['alice', 'bob']);
    alice?.edit((doc) => doc.getMap('objects').set('t', textObject('t', 'one two')));
    settle(alice as Peer, bob as Peer);

    alice?.edit((doc) => {
      const text = doc.getMap<Y.Map<unknown>>('objects').get('t')?.get('text') as Y.Text;
      text.insert(0, 'A ');
    });
    bob?.edit((doc) => {
      const text = doc.getMap<Y.Map<unknown>>('objects').get('t')?.get('text') as Y.Text;
      text.insert(text.length, ' Z');
    });
    settle(alice as Peer, bob as Peer);

    const textOf = (peer?: Peer) =>
      peer?.doc.getMap<Y.Map<unknown>>('objects').get('t')?.get('text')?.toString();
    const aliceText = textOf(alice);
    const bobText = textOf(bob);
    expect(aliceText).toBe(bobText);
    expect(aliceText).toContain('A ');
    expect(aliceText).toContain(' Z');
  });

  it('keep two clients in step through many interleaved edits', () => {
    const room = new Room('board-1', LIMITS);
    const [alice, bob] = connectAll(room, ['alice', 'bob']);
    const peers = [alice as Peer, bob as Peer];

    for (let step = 0; step < 40; step += 1) {
      const actor = peers[step % 2] as Peer;
      actor.edit((doc) => {
        const objects = doc.getMap<Y.Map<unknown>>('objects');
        if (step % 3 === 2 && objects.size > 0) {
          const [victim] = [...objects.keys()].sort();
          if (victim) objects.delete(victim);
        } else {
          objects.set(`obj-${step}`, textObject(`obj-${step}`, `note ${step}`));
        }
      });
      settle(...peers);
    }

    expect(objectIds(alice?.doc as Y.Doc)).toEqual(objectIds(bob?.doc as Y.Doc));
    expect(objectIds(alice?.doc as Y.Doc).length).toBeGreaterThan(0);
  });

  it('let a client that reconnects catch up on what it missed', () => {
    const room = new Room('board-1', LIMITS);
    const [alice, bob] = connectAll(room, ['alice', 'bob']);
    alice?.edit((doc) => doc.getMap('objects').set('before', textObject('before', 'x')));
    settle(alice as Peer, bob as Peer);

    room.leave('bob');
    alice?.edit((doc) => doc.getMap('objects').set('during', textObject('during', 'y')));
    settle(alice as Peer);

    const returning = new Peer('bob', room);
    returning.doc.getMap('objects').set('offline', textObject('offline', 'z'));
    returning.connect();
    settle(alice as Peer, returning);

    expect(objectIds(returning.doc)).toEqual(['before', 'during', 'offline']);
    expect(objectIds(alice?.doc as Y.Doc)).toEqual(['before', 'during', 'offline']);
  });
});

describe('read-only connections', () => {
  it('receive the document and cannot change it', () => {
    const room = new Room('board-1', LIMITS);
    const [editor, viewer] = connectAll(room, ['editor', 'viewer'], ['viewer']);
    editor?.edit((doc) => doc.getMap('objects').set('a', textObject('a', 'shared')));
    settle(editor as Peer, viewer as Peer);
    expect(objectIds(viewer?.doc as Y.Doc)).toEqual(['a']);

    // The viewer's own copy keeps the local edit, since nothing reverts it on the client. The
    // room and the other editors must not see it. See docs/sync.md for the viewer-echo limit.
    viewer?.edit((doc) => doc.getMap('objects').set('viewer-only', textObject('v', 'nope')));
    settle(editor as Peer, viewer as Peer);

    expect(objectIds(room.doc)).toEqual(['a']);
    expect(objectIds(editor?.doc as Y.Doc)).toEqual(['a']);
  });

  it('keep the viewer connected after its writes are dropped', () => {
    const room = new Room('board-1', LIMITS);
    const [, viewer] = connectAll(room, ['editor', 'viewer'], ['viewer']);
    viewer?.edit((doc) => doc.getMap('objects').set('nope', textObject('n', 'x')));

    expect(room.has('viewer')).toBe(true);
  });
});

// The bytes of the Yjs update produced by one change to a fresh document.
function updateOf(change: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  change(doc);
  return Y.mergeUpdates(updates);
}

describe('frame and resource limits', () => {
  it('rejects a frame larger than the payload limit before decoding it', () => {
    const room = new Room('board-1', LIMITS);
    room.join(new FakeConnection('a', 'a'));
    const huge = encodeSyncUpdate(new Uint8Array(LIMITS.maxPayloadBytes + 1));

    expect(() => room.receive('a', huge)).toThrow(ProtocolError);
  });

  it('rejects a malformed frame with a protocol error', () => {
    const room = new Room('board-1', LIMITS);
    room.join(new FakeConnection('a', 'a'));

    expect(() => room.receive('a', new Uint8Array([9, 9, 9]))).toThrow(ProtocolError);
  });

  it('rejects an update that the document cannot apply', () => {
    const room = new Room('board-1', LIMITS);
    room.join(new FakeConnection('a', 'a'));

    expect(() => room.receive('a', encodeSyncUpdate(new Uint8Array([0xff, 0xff, 0xff])))).toThrow(
      ProtocolError,
    );
  });

  it('enforces the update rate per connection, not per room', () => {
    const now = { value: 0 };
    const room = new Room(
      'board-1',
      { ...LIMITS, maxUpdateBytesPerSecond: 100 },
      () => now.value,
    );
    const spammer = new FakeConnection('spammer', 'spammer');
    const quiet = new FakeConnection('quiet', 'quiet');
    room.join(spammer);
    room.join(quiet);

    const big = updateOf((doc) => doc.getMap('objects').set('k', 'x'.repeat(200)));
    const small = updateOf((doc) => doc.getMap('objects').set('n', 1));
    expect(small.byteLength).toBeLessThan(100);

    // The spammer exhausts its own budget, and the quiet connection is still served.
    expect(() => room.receive('spammer', encodeSyncUpdate(big))).toThrow(/rate limit/);
    expect(() => room.receive('quiet', encodeSyncUpdate(small))).not.toThrow();

    // Once the window rolls over the spammer may write again.
    now.value = 1500;
    expect(() => room.receive('spammer', encodeSyncUpdate(small))).not.toThrow();
  });

  it('refuses new connections once the room is full', () => {
    const room = new Room('board-1', { ...LIMITS, maxConnectionsPerRoom: 2 });

    expect(room.join(new FakeConnection('a', 'a')).ok).toBe(true);
    expect(room.join(new FakeConnection('b', 'b')).ok).toBe(true);
    expect(room.join(new FakeConnection('c', 'c'))).toEqual({ ok: false, reason: 'full' });
  });

  it('drops a connection whose socket cannot take frames, without affecting the others', () => {
    const room = new Room('board-1', LIMITS);
    const healthy = new FakeConnection('healthy', 'healthy');
    const broken = new FakeConnection('broken', 'broken');
    const sender = new FakeConnection('sender', 'sender');
    room.join(healthy);
    room.join(broken);
    room.join(sender);
    broken.alive = false;

    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));
    doc.getMap('objects').set('k', 'v');
    room.receive('sender', encodeSyncUpdate(updates[0] as Uint8Array));

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

  it('relays presence updates to other clients', () => {
    const room = new Room('board-1', LIMITS);
    const [alice, bob] = connectAll(room, ['alice', 'bob']);
    const presence = awarenessRemoval([{ clientId: 42, clock: 1 }]);

    alice?.sendFrame(encodeAwareness(presence));

    expect(bob?.connection.frames.length).toBeGreaterThan(0);
  });

  it('announces a departed client as gone, with a clock newer than its last update', () => {
    const room = new Room('board-1', LIMITS);
    const [alice, bob] = connectAll(room, ['alice', 'bob']);
    alice?.sendFrame(encodeAwareness(awarenessRemoval([{ clientId: 42, clock: 5 }])));
    bob?.connection.frames.splice(0);

    room.leave('alice');

    const removal = bob?.connection.frames.at(-1);
    expect(removal).toBeDefined();
    expect(removal && readAwareness(removal.subarray(2))).toEqual([{ clientId: 42, clock: 6 }]);
  });
});

describe('room lifecycle', () => {
  it('reports the number of connections it holds', () => {
    const room = new Room('board-1', LIMITS);
    room.join(new FakeConnection('a', 'a'));
    room.join(new FakeConnection('b', 'b'));
    room.leave('a');

    expect(room.size).toBe(1);
  });

  it('ignores frames from a connection that has left', () => {
    const room = new Room('board-1', LIMITS);
    room.join(new FakeConnection('a', 'a'));
    room.leave('a');

    expect(() => room.receive('a', encodeSyncUpdate(new Uint8Array(0)))).toThrow(
      /not in this room/,
    );
  });
});
