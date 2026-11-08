import * as Y from 'yjs';
import {
  Decoder,
  Encoder,
  ProtocolError,
  decodeClientMessage,
  encodeAwareness,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
  type ClientMessage,
} from '@inkroom/shared';

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

interface Subscriber {
  connection: RoomConnection;
  // Latest awareness clock seen for each client id this connection announced. A removal must carry
  // a clock above this, or peers that already hold the entry ignore it.
  awarenessClocks: Map<number, number>;
  windowStart: number;
  windowBytes: number;
}

export type JoinResult = { ok: true } | { ok: false; reason: 'full' };

// The live state of one board. Every connection to the board shares this room. The Yjs document
// is held in memory only, so it is lost when the last connection leaves; persistence comes later.
export class Room {
  readonly boardId: string;
  readonly doc: Y.Doc;
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly limits: RoomLimits;
  private readonly now: () => number;

  constructor(boardId: string, limits: RoomLimits, now: () => number = Date.now) {
    this.boardId = boardId;
    this.limits = limits;
    this.now = now;
    this.doc = new Y.Doc();
  }

  get size(): number {
    return this.subscribers.size;
  }

  has(connectionId: string): boolean {
    return this.subscribers.has(connectionId);
  }

  // Adds a connection and sends the room's state vector. The client answers with the updates the
  // room lacks (step 2), and the room answers the client's state vector with what the client lacks.
  join(connection: RoomConnection): JoinResult {
    if (this.subscribers.size >= this.limits.maxConnectionsPerRoom) {
      return { ok: false, reason: 'full' };
    }
    this.subscribers.set(connection.id, {
      connection,
      awarenessClocks: new Map(),
      windowStart: 0,
      windowBytes: 0,
    });
    connection.send(encodeSyncStep1(Y.encodeStateVector(this.doc)));
    return { ok: true };
  }

  // Removes a connection and tells the others that its presence has gone.
  leave(connectionId: string): void {
    const subscriber = this.subscribers.get(connectionId);
    if (!subscriber) {
      return;
    }
    this.subscribers.delete(connectionId);
    if (subscriber.awarenessClocks.size > 0) {
      const removals = [...subscriber.awarenessClocks].map(([clientId, clock]) => ({
        clientId,
        clock: clock + 1,
      }));
      this.broadcast(connectionId, encodeAwareness(awarenessRemoval(removals)));
    }
  }

  // Handles one frame from a connection. A frame that is malformed, too large, or over the rate
  // limit throws, and the transport then closes that connection.
  receive(connectionId: string, frame: Uint8Array): void {
    const subscriber = this.subscribers.get(connectionId);
    if (!subscriber) {
      throw new ProtocolError('connection is not in this room');
    }
    const message = decodeClientMessage(frame, this.limits.maxPayloadBytes);
    this.handle(subscriber, message);
  }

  private handle(subscriber: Subscriber, message: ClientMessage): void {
    const from = subscriber.connection;
    if (message.kind === 'awareness') {
      for (const entry of readAwareness(message.update)) {
        subscriber.awarenessClocks.set(entry.clientId, entry.clock);
      }
      this.broadcast(from.id, encodeAwareness(message.update));
      return;
    }

    switch (message.sync.kind) {
      case 'step1': {
        // The client describes what it has. Send what it lacks, and ask for what the room lacks.
        const missing = Y.encodeStateAsUpdate(this.doc, message.sync.stateVector);
        from.send(encodeSyncStep2(missing));
        from.send(encodeSyncStep1(Y.encodeStateVector(this.doc)));
        return;
      }
      case 'step2':
      case 'update':
        if (from.readOnly) {
          // Viewers can read but not change the document. Their writes are discarded, and the
          // connection stays open, so a viewer's client does not reconnect in a loop.
          return;
        }
        this.applyFromClient(subscriber, message.sync.update);
        return;
    }
  }

  private applyFromClient(subscriber: Subscriber, update: Uint8Array): void {
    this.chargeRate(subscriber, update.byteLength);
    try {
      Y.applyUpdate(this.doc, update, subscriber.connection.id);
    } catch {
      // A structurally invalid update is the client's fault, and it must not reach the others.
      throw new ProtocolError('update could not be applied');
    }
    this.broadcast(subscriber.connection.id, encodeSyncUpdate(update));
  }

  // Charges bytes against this connection's one-second window. Once the budget is spent, its
  // updates are refused until the window rolls over.
  private chargeRate(subscriber: Subscriber, bytes: number): void {
    const now = this.now();
    if (now - subscriber.windowStart >= 1000) {
      subscriber.windowStart = now;
      subscriber.windowBytes = 0;
    }
    subscriber.windowBytes += bytes;
    if (subscriber.windowBytes > this.limits.maxUpdateBytesPerSecond) {
      throw new ProtocolError('update rate limit exceeded');
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

  destroy(): void {
    this.subscribers.clear();
    this.doc.destroy();
  }
}

interface AwarenessEntry {
  clientId: number;
  clock: number;
}

// Awareness payload: varUint(count), then per entry varUint(clientId), varUint(clock), and the
// state as a length-prefixed JSON string. A state of "null" marks the client as gone. Entries that
// cannot be read are skipped, so a malformed update still reaches peers unchanged.
export function readAwareness(update: Uint8Array): AwarenessEntry[] {
  try {
    const decoder = new Decoder(update);
    const count = decoder.readVarUint();
    const entries: AwarenessEntry[] = [];
    for (let index = 0; index < count; index += 1) {
      const clientId = decoder.readVarUint();
      const clock = decoder.readVarUint();
      decoder.readVarBytes(Number.MAX_SAFE_INTEGER);
      entries.push({ clientId, clock });
    }
    return entries;
  } catch {
    return [];
  }
}

// An awareness payload that marks each client as gone. Peers drop its presence on receipt, as long
// as each clock is newer than the one they hold.
export function awarenessRemoval(entries: AwarenessEntry[]): Uint8Array {
  const encoder = new Encoder();
  encoder.writeVarUint(entries.length);
  const nullState = new TextEncoder().encode('null');
  for (const entry of entries) {
    encoder.writeVarUint(entry.clientId);
    encoder.writeVarUint(entry.clock);
    encoder.writeVarBytes(nullState);
  }
  return encoder.toUint8Array();
}
