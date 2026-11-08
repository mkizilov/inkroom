import * as Y from 'yjs';
import type { Awareness } from './awareness';
import {
  decodeClientMessage,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
} from './sync-protocol';

// The client half of the sync protocol, free of any socket. A transport calls `receive` for each
// incoming frame and sends whatever `start` and `receive` return. Keeping this separate from the
// socket lets the server tests run several real clients without a network.
//
// Handshake: each side sends its state vector once (`start` here, the join on the room). A state
// vector is answered with a step 2 that carries what the sender lacks, and with nothing else. A
// state vector answered by another state vector would never stop.

const MAX_FRAME_BYTES = 1024 * 1024;

export interface SyncClientOptions {
  doc: Y.Doc;
  // Origin used for updates that arrive from the server, so local undo does not track them.
  remoteOrigin: unknown;
  // Receives remote presence. Optional, so a client without presence still syncs documents.
  awareness?: Awareness;
  // Told when the server changes this connection's role, so the UI can match what is allowed.
  onRole?: (role: string) => void;
  // Told each time the server has stored one of this client's frames.
  onAck?: (seq: number) => void;
  // Told when the server answers this client's state vector, which is the end of the handshake.
  onHandshake?: () => void;
}

export class SyncClient {
  readonly doc: Y.Doc;
  // Highest sequence number the server has confirmed as stored. Updates up to it are durable.
  acknowledgedSeq = 0;
  private readonly remoteOrigin: unknown;
  private readonly awareness: Awareness | undefined;
  private readonly onRole: ((role: string) => void) | undefined;
  private readonly onAck: ((seq: number) => void) | undefined;
  private readonly onHandshake: (() => void) | undefined;

  constructor(options: SyncClientOptions) {
    this.doc = options.doc;
    this.remoteOrigin = options.remoteOrigin;
    this.awareness = options.awareness;
    this.onRole = options.onRole;
    this.onAck = options.onAck;
    this.onHandshake = options.onHandshake;
  }

  // The first frame a client sends on a fresh connection: its state vector, so the server can
  // reply with what the client lacks. The server also sends its own state vector on join.
  start(): Uint8Array {
    return encodeSyncStep1(Y.encodeStateVector(this.doc));
  }

  // Returns the frames to send in reply to an incoming frame.
  receive(frame: Uint8Array): Uint8Array[] {
    const message = decodeClientMessage(frame, MAX_FRAME_BYTES);
    if (message.kind === 'awareness') {
      this.awareness?.applyUpdate(message.update);
      return [];
    }
    if (message.kind === 'ack') {
      this.acknowledgedSeq = Math.max(this.acknowledgedSeq, message.seq);
      this.onAck?.(message.seq);
      return [];
    }
    if (message.kind === 'role') {
      this.onRole?.(message.role);
      return [];
    }
    switch (message.sync.kind) {
      case 'step1':
        return [encodeSyncStep2(Y.encodeStateAsUpdate(this.doc, message.sync.stateVector))];
      case 'step2':
        Y.applyUpdate(this.doc, message.sync.update, this.remoteOrigin);
        this.onHandshake?.();
        return [];
      case 'update':
        Y.applyUpdate(this.doc, message.sync.update, this.remoteOrigin);
        return [];
    }
  }

  // Frames for one local change. Call this from the document's 'update' event, for updates that
  // did not come from the server.
  frameForLocalUpdate(update: Uint8Array): Uint8Array {
    return encodeSyncUpdate(update);
  }
}

// True when a frame this client sends changes the document. The server stores and acknowledges
// such a frame. A frame without changes is ignored, and it is not acknowledged.
export function carriesChanges(frame: Uint8Array): boolean {
  const message = decodeClientMessage(frame, MAX_FRAME_BYTES);
  if (message.kind !== 'sync') {
    return false;
  }
  const { sync } = message;
  if (sync.kind === 'step1') {
    return false;
  }
  const update = Y.decodeUpdate(sync.update);
  return update.structs.length > 0 || update.ds.clients.size > 0;
}
