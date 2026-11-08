import * as Y from 'yjs';
import {
  MAX_AWARENESS_STATE_BYTES,
  ProtocolError,
  decodeAwarenessEntries,
  decodeClientMessage,
  encodeAck,
  encodeAwareness,
  encodeAwarenessEntries,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
  type AwarenessEntry,
  type ClientMessage,
} from '@inkroom/shared';
import type { BoardStore } from '../persistence/store';
import { DEFAULT_PRESENCE_LIMITS, PresenceRegistry, type PresenceLimits } from './presence';

// A connection as the room sees it. The transport supplies `send`, which returns false when the
// socket can no longer take frames.
export interface RoomConnection {
  readonly id: string;
  readonly userId: string;
  // Viewers join read-only: they receive the document, but their writes are dropped.
  readonly readOnly: boolean;
  send(frame: Uint8Array): boolean;
}

export interface RoomLimits {
  maxPayloadBytes: number;
  maxConnectionsPerRoom: number;
  // Per connection, so one client cannot use up the budget of everyone else in the room.
  maxUpdateBytesPerSecond: number;
}

export const DEFAULT_ROOM_LIMITS: RoomLimits = {
  maxPayloadBytes: 1024 * 1024,
  maxConnectionsPerRoom: 50,
  maxUpdateBytesPerSecond: 4 * 1024 * 1024,
};

// Presence frames are small and frequent (cursor moves). This bounds them per connection, with room
// for the throttled cursor rate and a heartbeat.
export const MAX_PRESENCE_FRAMES_PER_SECOND = 100;

export type RoomPersistence = Pick<BoardStore, 'appendUpdate' | 'compact'>;

export interface RoomOptions {
  boardId: string;
  doc: Y.Doc;
  store: RoomPersistence;
  limits: RoomLimits;
  // Start a compaction after this many updates have been stored by this room.
  compactEvery: number;
  now: () => number;
  // Receives background work (compaction) so the owner can wait for it and report its failures.
  track: (work: Promise<unknown>) => void;
  presence?: Partial<PresenceLimits>;
}

interface Subscriber {
  connection: RoomConnection;
  windowStart: number;
  windowBytes: number;
  presenceWindowStart: number;
  presenceFrames: number;
}

export type JoinResult = { ok: true } | { ok: false; reason: 'full' | 'closed' };

// The live state of one board. Every connection to the board shares this room.
//
// Durability rule: a client update is validated, then stored, and only after the store confirms it
// is applied to memory, broadcast to the other connections, and acknowledged to its sender. Memory
// therefore never holds an update that the database lacks. Updates are handled one at a time in
// arrival order, so the stored order matches the order the room applied them.
//
// Presence is different: it is held in memory only and is never stored. It is relayed as it
// arrives, and a newly joined connection receives the current participants.
export class Room {
  readonly boardId: string;
  readonly doc: Y.Doc;
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly options: RoomOptions;
  private readonly presence: PresenceRegistry;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private appendsSinceCompaction = 0;

  constructor(options: RoomOptions) {
    this.options = options;
    this.boardId = options.boardId;
    this.doc = options.doc;
    this.presence = new PresenceRegistry(
      { ...DEFAULT_PRESENCE_LIMITS, ...options.presence },
      options.now,
    );
  }

  get size(): number {
    return this.subscribers.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  has(connectionId: string): boolean {
    return this.subscribers.has(connectionId);
  }

  // Adds a connection, sends the room's state vector, and then the participants already present.
  // The client answers the state vector with the updates the room lacks (step 2), and the room
  // answers the client's state vector with what the client lacks.
  join(connection: RoomConnection): JoinResult {
    if (this.closed) {
      return { ok: false, reason: 'closed' };
    }
    if (this.subscribers.size >= this.options.limits.maxConnectionsPerRoom) {
      return { ok: false, reason: 'full' };
    }
    this.subscribers.set(connection.id, {
      connection,
      windowStart: 0,
      windowBytes: 0,
      presenceWindowStart: 0,
      presenceFrames: 0,
    });
    connection.send(encodeSyncStep1(Y.encodeStateVector(this.doc)));
    const participants = this.presence.snapshot();
    if (participants.length > 0) {
      connection.send(encodeAwareness(encodeAwarenessEntries(participants)));
    }
    return { ok: true };
  }

  // Removes a connection and tells the others that everything it held is gone.
  leave(connectionId: string): void {
    const subscriber = this.subscribers.get(connectionId);
    if (!subscriber) {
      return;
    }
    this.subscribers.delete(connectionId);
    this.relayPresence(this.presence.release(connectionId), '');
  }

  // Removes participants whose state has gone stale. Called on the heartbeat.
  expirePresence(): void {
    if (this.closed) {
      return;
    }
    this.relayPresence(this.presence.expire(), '');
  }

  // Handles one frame from a connection. The frame is decoded now, and handled after every earlier
  // frame has finished. A rejected promise means the frame was refused; the caller then closes the
  // connection.
  receive(connectionId: string, frame: Uint8Array): Promise<void> {
    const subscriber = this.subscribers.get(connectionId);
    if (!subscriber) {
      return Promise.reject(new ProtocolError('connection is not in this room'));
    }
    let message: ClientMessage;
    try {
      message = decodeClientMessage(frame, this.options.limits.maxPayloadBytes);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(() => this.handle(subscriber, message));
  }

  // Applies an update that the store has already written, such as a restore, and tells the
  // connections. Nothing is written again.
  applyPersisted(update: Uint8Array): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) {
        return;
      }
      Y.applyUpdate(this.doc, update, 'restore');
      this.broadcast('', encodeSyncUpdate(update));
    });
  }

  // Ends the room. Its document is released; the stored log is unaffected, so a later room for the
  // same board rebuilds the same state. Presence is discarded with the room.
  destroy(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.subscribers.clear();
    if (this.appendsSinceCompaction > 0) {
      this.appendsSinceCompaction = 0;
      this.options.track(this.options.store.compact(this.boardId));
    }
    this.doc.destroy();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    // A failed task must not stop the tasks queued after it.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async handle(subscriber: Subscriber, message: ClientMessage): Promise<void> {
    if (this.closed || !this.subscribers.has(subscriber.connection.id)) {
      return;
    }
    const from = subscriber.connection;

    switch (message.kind) {
      case 'awareness': {
        this.chargePresence(subscriber);
        const entries = decodeAwarenessEntries(message.update, MAX_AWARENESS_STATE_BYTES);
        this.relayPresence(this.presence.accept(from.id, entries), from.id);
        return;
      }
      case 'ack':
        throw new ProtocolError('clients may not send acknowledgements');
      case 'sync':
        break;
    }

    const sync = message.sync;
    if (sync.kind === 'step1') {
      // The client describes what it has. Send what it lacks, and ask for what the room lacks.
      const missing = Y.encodeStateAsUpdate(this.doc, sync.stateVector);
      from.send(encodeSyncStep2(missing));
      from.send(encodeSyncStep1(Y.encodeStateVector(this.doc)));
      return;
    }
    if (from.readOnly) {
      // Viewers can read but not change the document. Their writes are discarded and the connection
      // stays open, so a viewer's client does not reconnect in a loop.
      return;
    }
    await this.commit(subscriber, sync.update);
  }

  // Both update frames and step-2 replies carry client changes (step 2 is how a reconnecting
  // client sends its offline edits), so both are stored and acknowledged the same way.
  private async commit(subscriber: Subscriber, update: Uint8Array): Promise<void> {
    const connection = subscriber.connection;
    const decoded = decodeOrRefuse(update);
    this.chargeRate(subscriber, update.byteLength);
    if (decoded.structs.length === 0 && decoded.ds.clients.size === 0) {
      // Nothing new in this update, so there is nothing to store.
      return;
    }

    // If this rejects, nothing has been applied or sent, and the client still holds the update. It
    // is sent again on its next connection, through the state-vector handshake.
    const seq = await this.options.store.appendUpdate(this.boardId, connection.userId, update);
    if (this.closed) {
      // The room ended while the write was in flight. The update is stored, so the next room for
      // this board will include it.
      return;
    }

    Y.applyUpdate(this.doc, update, connection.id);
    this.broadcast(connection.id, encodeSyncUpdate(update));
    connection.send(encodeAck(seq));

    this.appendsSinceCompaction += 1;
    if (this.appendsSinceCompaction >= this.options.compactEvery) {
      this.appendsSinceCompaction = 0;
      this.options.track(this.options.store.compact(this.boardId));
    }
  }

  // Charges bytes against this connection's one-second window. Once the budget is spent, its
  // updates are refused until the window rolls over.
  private chargeRate(subscriber: Subscriber, bytes: number): void {
    const now = this.options.now();
    if (now - subscriber.windowStart >= 1000) {
      subscriber.windowStart = now;
      subscriber.windowBytes = 0;
    }
    subscriber.windowBytes += bytes;
    if (subscriber.windowBytes > this.options.limits.maxUpdateBytesPerSecond) {
      throw new ProtocolError('update rate limit exceeded');
    }
  }

  // Charges one presence frame against this connection's one-second window.
  private chargePresence(subscriber: Subscriber): void {
    const now = this.options.now();
    if (now - subscriber.presenceWindowStart >= 1000) {
      subscriber.presenceWindowStart = now;
      subscriber.presenceFrames = 0;
    }
    subscriber.presenceFrames += 1;
    if (subscriber.presenceFrames > MAX_PRESENCE_FRAMES_PER_SECOND) {
      throw new ProtocolError('presence update rate limit exceeded');
    }
  }

  private relayPresence(entries: AwarenessEntry[], exceptId: string): void {
    if (entries.length > 0) {
      this.broadcast(exceptId, encodeAwareness(encodeAwarenessEntries(entries)));
    }
  }

  // Sends a frame to every connection except `exceptId`. A connection that cannot take the frame
  // is removed, so one broken socket cannot hold up the others.
  private broadcast(exceptId: string, frame: Uint8Array): void {
    const failed: string[] = [];
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.connection.id !== exceptId && !subscriber.connection.send(frame)) {
        failed.push(subscriber.connection.id);
      }
    }
    for (const id of failed) {
      this.leave(id);
    }
  }
}

// Decodes an update's structure before anything is stored. A structurally invalid update is the
// client's fault, and it must not reach the store or the other clients.
function decodeOrRefuse(update: Uint8Array): ReturnType<typeof Y.decodeUpdate> {
  try {
    return Y.decodeUpdate(update);
  } catch {
    throw new ProtocolError('update is malformed');
  }
}

// Lenient reading of an awareness body: returns the ids and clocks, or nothing when unreadable.
// Kept for tooling and tests; the room itself reads presence strictly.
export function readAwareness(update: Uint8Array): Array<{ clientId: number; clock: number }> {
  try {
    return decodeAwarenessEntries(update, Number.MAX_SAFE_INTEGER).map(({ clientId, clock }) => ({
      clientId,
      clock,
    }));
  } catch {
    return [];
  }
}

// An awareness body that marks each id as gone, with the given clocks.
export function awarenessRemoval(entries: Array<{ clientId: number; clock: number }>): Uint8Array {
  return encodeAwarenessEntries(
    entries.map(({ clientId, clock }) => ({ clientId, clock, json: null })),
  );
}
