import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  Awareness,
  encodeAck,
  encodeAwareness,
  encodeRole,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
} from '@inkroom/shared';
import { CanvasDocument } from '../doc/canvas-document';
import {
  POLICY_VIOLATION_CLOSE,
  SyncProvider,
  type ConnectionState,
  type SocketLike,
  type TimerLike,
} from './provider';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

// A socket the test drives by hand. Opening it, delivering frames and closing it are all explicit.
class FakeSocket implements SocketLike {
  binaryType = 'blob';
  readyState = CONNECTING;
  readonly sent: Uint8Array[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = CLOSED;
  }
  open(): void {
    this.readyState = OPEN;
    this.onopen?.({});
  }
  receive(frame: Uint8Array): void {
    this.onmessage?.({ data: new Uint8Array(frame).buffer });
  }
  drop(code: number, reason = ''): void {
    this.readyState = CLOSED;
    this.onclose?.({ code, reason });
  }
}

// Timers that run only when the test fires them, so the delays can be checked exactly.
class ManualTimers implements TimerLike {
  private nextId = 1;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();
  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { callback, ms });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  fireNext(): number {
    const first = [...this.pending.entries()][0];
    if (!first) {
      throw new Error('no timer is pending');
    }
    const [id, timer] = first;
    this.pending.delete(id);
    timer.callback();
    return timer.ms;
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers = new ManualTimers();
  const states: ConnectionState[] = [];
  const revoked: string[] = [];
  const document = new CanvasDocument();
  const provider = new SyncProvider({
    document,
    url: 'ws://127.0.0.1:21173/api/boards/b/sync',
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    timers,
    random: () => 1,
    minBackoffMs: 100,
    maxBackoffMs: 1000,
    onState: (state) => states.push(state),
    onRevoked: (reason) => revoked.push(reason),
  });
  return { provider, document, sockets, timers, states, revoked };
}

function rectangle(n: number) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    type: 'rectangle' as const,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    stroke: '#000000',
    strokeWidth: 2,
  };
}

describe('sync provider connection', () => {
  it('opens a socket for binary frames, sends its state vector, and reports connected once the server answers', () => {
    const { provider, sockets, states } = harness();
    provider.start();
    sockets[0]?.open();

    expect(sockets[0]?.binaryType).toBe('arraybuffer');
    expect(sockets[0]?.sent[0]?.[0]).toBe(0);
    expect(states).toEqual(['connecting', 'syncing']);

    sockets[0]?.receive(encodeSyncStep2(Y.encodeStateAsUpdate(new Y.Doc())));
    expect(states).toEqual(['connecting', 'syncing', 'connected']);
    provider.stop();
  });

  it('answers the server state vector, and applies the updates the server sends', () => {
    const { provider, document, sockets } = harness();
    provider.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    const sentBefore = socket.sent.length;

    // The server holds one object and announces its state vector, as the room does on join.
    const serverDoc = new Y.Doc();
    serverDoc.getMap('objects').set('from-server', 'hello');
    socket.receive(encodeSyncStep1(Y.encodeStateVector(serverDoc)));

    expect(socket.sent.length).toBeGreaterThan(sentBefore);

    socket.receive(encodeSyncUpdate(Y.encodeStateAsUpdate(serverDoc)));
    expect(document.doc.getMap('objects').get('from-server')).toBe('hello');
    provider.stop();
  });

  it('sends each local change to the server as it is made', () => {
    const { provider, document, sockets } = harness();
    provider.start();
    sockets[0]?.open();
    const before = sockets[0]?.sent.length ?? 0;

    document.apply([{ type: 'insert', index: 0, objects: [rectangle(1)] }], { boundary: true });
    document.apply([{ type: 'update', id: rectangle(1).id, changes: { x: 5 } }], {
      boundary: false,
    });

    expect((sockets[0]?.sent.length ?? 0) - before).toBe(2);
    provider.stop();
  });

  it('retries a connection that never opens, backing off up to the maximum', () => {
    const { provider, sockets, timers } = harness();
    provider.start();

    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      (sockets.at(-1) as FakeSocket).drop(1006);
      delays.push(timers.fireNext());
    }

    expect(delays).toEqual([100, 200, 400, 800, 1000, 1000]);
    expect(sockets).toHaveLength(7);
    provider.stop();
  });

  it('resets the backoff once a connection has opened', () => {
    const { provider, sockets, timers } = harness();
    provider.start();
    sockets[0]?.drop(1006);
    timers.fireNext();
    sockets[1]?.drop(1006);
    timers.fireNext();
    sockets[2]?.open();
    sockets[2]?.drop(1006);

    expect(timers.fireNext()).toBe(100);
    provider.stop();
  });

  it('reports offline while waiting to retry, and connected again once reopened', () => {
    const { provider, sockets, timers, states } = harness();
    provider.start();
    sockets[0]?.open();
    sockets[0]?.drop(1006);
    expect(provider.connectionState).toBe('offline');

    timers.fireNext();
    sockets[1]?.open();

    expect(states).toContain('offline');
    expect(provider.connectionState).toBe('syncing');

    sockets[1]?.receive(encodeSyncStep2(Y.encodeStateAsUpdate(new Y.Doc())));
    expect(provider.connectionState).toBe('connected');
    provider.stop();
  });

  it('stops for good when the server refuses the board, and does not retry', () => {
    const { provider, sockets, timers, states } = harness();
    provider.start();
    sockets[0]?.open();
    sockets[0]?.drop(POLICY_VIOLATION_CLOSE);

    expect(timers.pending.size).toBe(0);
    expect(sockets).toHaveLength(1);
    expect(states.at(-1)).toBe('stopped');
  });

  it('does not reconnect after stop() is called', () => {
    const { provider, sockets, timers } = harness();
    provider.start();
    sockets[0]?.open();
    provider.stop();

    expect(timers.pending.size).toBe(0);
    expect(sockets).toHaveLength(1);
    expect(provider.connectionState).toBe('stopped');
  });

  it('carries a change made while offline in the reconnect handshake, not in a queue', () => {
    const { provider, document, sockets, timers } = harness();
    provider.start();
    sockets[0]?.open();
    sockets[0]?.drop(1006);

    // Edited while the socket is down: nothing is sent now, and the change stays in the document.
    const sentWhileOffline = sockets[0]?.sent.length ?? 0;
    document.apply([{ type: 'insert', index: 0, objects: [rectangle(2)] }], { boundary: true });
    expect(sockets[0]?.sent.length).toBe(sentWhileOffline);

    timers.fireNext();
    const reconnect = sockets.at(-1) as FakeSocket;
    reconnect.open();

    // The first frame is a step 1 whose state vector already includes the offline change, so the
    // server's reply will carry it.
    const first = reconnect.sent[0] as Uint8Array;
    const stateVector = first.subarray(3);
    expect(Array.from(stateVector)).toEqual(Array.from(Y.encodeStateVector(document.doc)));
    provider.stop();
  });
});

describe('presence over the sync socket', () => {
  const remotePresence = (clientId: number, name: string) => {
    const other = new Awareness();
    other.setLocalState({
      user: { id: '00000000-0000-4000-8000-0000000000bb', name, color: '#2f9e44' },
      cursor: { x: 1, y: 2 },
      selection: [],
    });
    return other;
  };

  it('sends this presence on connect, and later changes as they happen', () => {
    const { provider, document, sockets } = harness();
    document.awareness.setLocalState({
      user: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Ada', color: '#1971c2' },
      cursor: null,
      selection: [],
    });
    provider.start();
    sockets[0]?.open();
    const beforeChange = sockets[0]?.sent.length ?? 0;

    document.awareness.setLocalState({
      user: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Ada', color: '#1971c2' },
      cursor: { x: 3, y: 4 },
      selection: [],
    });

    const sentOnConnect = sockets[0]?.sent.some((frame) => frame[0] === 1 && frame.length > 0);
    expect(sentOnConnect).toBe(true);
    expect((sockets[0]?.sent.length ?? 0) - beforeChange).toBe(1);
    provider.stop();
  });

  it('applies remote presence it receives, without sending it back', () => {
    const { provider, document, sockets } = harness();
    provider.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    const sentBefore = socket.sent.length;

    const bob = remotePresence(7, 'Bob');
    socket.receive(encodeAwareness(bob.encodeLocal()));

    expect(document.awareness.remoteStates().map((entry) => entry.state)).toEqual([
      expect.objectContaining({ user: expect.objectContaining({ name: 'Bob' }) }),
    ]);
    expect(socket.sent.length).toBe(sentBefore);
    provider.stop();
  });

  it('forgets remote participants on disconnect, and sends presence again on reconnect', () => {
    const { provider, document, sockets, timers } = harness();
    provider.start();
    sockets[0]?.open();
    sockets[0]?.receive(encodeAwareness(remotePresence(7, 'Bob').encodeLocal()));
    expect(document.awareness.remoteStates()).toHaveLength(1);

    sockets[0]?.drop(1006);

    expect(document.awareness.remoteStates()).toEqual([]);
    timers.fireNext();
    sockets.at(-1)?.open();
    expect(sockets.at(-1)?.sent.length).toBeGreaterThan(0);
    provider.stop();
  });

  it('does not forward a remote presence change back to the server', () => {
    const { provider, sockets } = harness();
    provider.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    const before = socket.sent.length;

    socket.receive(encodeAwareness(remotePresence(9, 'Carol').encodeLocal()));
    socket.receive(encodeAwareness(remotePresence(9, 'Carol').encodeLocal()));

    expect(socket.sent.length).toBe(before);
    provider.stop();
  });
});

describe('pending changes and revocation', () => {
  it('counts a local change as pending until the server stores it', () => {
    const { provider, document, sockets } = harness();
    provider.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    socket.receive(encodeSyncStep2(Y.encodeStateAsUpdate(new Y.Doc())));

    document.apply([{ type: 'insert', index: 0, objects: [rectangle(1)] }], { boundary: true });
    expect(provider.connectionState).toBe('syncing');

    socket.receive(encodeAck(1));
    expect(provider.connectionState).toBe('connected');
    provider.stop();
  });

  it('keeps changes made offline pending until the server stores them after reconnecting', () => {
    const { provider, document, sockets, timers } = harness();
    provider.start();
    sockets[0]?.open();
    sockets[0]?.receive(encodeSyncStep2(Y.encodeStateAsUpdate(new Y.Doc())));
    sockets[0]?.drop(1006);

    document.apply([{ type: 'insert', index: 0, objects: [rectangle(2)] }], { boundary: true });
    timers.fireNext();
    const reconnect = sockets.at(-1) as FakeSocket;
    reconnect.open();
    // The server asks what the client holds. The client's answer carries the offline change.
    reconnect.receive(encodeSyncStep1(Y.encodeStateVector(new Y.Doc())));
    reconnect.receive(encodeSyncStep2(Y.encodeStateAsUpdate(new Y.Doc())));
    expect(provider.connectionState).toBe('syncing');

    reconnect.receive(encodeAck(1));
    expect(provider.connectionState).toBe('connected');
    provider.stop();
  });

  it('clears the pending count when the server makes this client a viewer', () => {
    const { provider, document, sockets } = harness();
    provider.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    socket.receive(encodeSyncStep2(Y.encodeStateAsUpdate(new Y.Doc())));
    document.apply([{ type: 'insert', index: 0, objects: [rectangle(1)] }], { boundary: true });
    expect(provider.connectionState).toBe('syncing');

    socket.receive(encodeRole('viewer'));

    expect(provider.connectionState).toBe('connected');
    provider.stop();
  });

  it('reports a revocation with the reason the server gave, and does not reconnect', () => {
    const { provider, sockets, timers, revoked } = harness();
    provider.start();
    sockets[0]?.open();

    sockets[0]?.drop(POLICY_VIOLATION_CLOSE, 'access revoked');

    expect(revoked).toEqual(['access revoked']);
    expect(timers.pending.size).toBe(0);
    expect(provider.connectionState).toBe('stopped');
  });
});
