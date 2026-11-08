import * as Y from 'yjs';
import {
  decodeClientMessage,
  encodeAwareness,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
} from './sync-protocol';

// The client half of the sync protocol, free of any socket. A transport calls `receive` for each
// incoming frame and sends whatever `start`, `onLocalUpdate` and `receive` return. Keeping this
// separate from the socket lets the server tests run two real clients without a network.

const MAX_FRAME_BYTES = 1024 * 1024;

export interface SyncClientOptions {
  doc: Y.Doc;
  // Origin used for updates that arrive from the server, so local undo does not track them.
  remoteOrigin: unknown;
}

export class SyncClient {
  readonly doc: Y.Doc;
  // Highest sequence number the server has confirmed as stored. Updates up to it are durable.
  acknowledgedSeq = 0;
  private readonly remoteOrigin: unknown;

  constructor(options: SyncClientOptions) {
    this.doc = options.doc;
    this.remoteOrigin = options.remoteOrigin;
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
      return [];
    }
    if (message.kind === 'ack') {
      this.acknowledgedSeq = Math.max(this.acknowledgedSeq, message.seq);
      return [];
    }
    switch (message.sync.kind) {
      case 'step1':
        return [
          encodeSyncStep2(Y.encodeStateAsUpdate(this.doc, message.sync.stateVector)),
          encodeSyncStep1(Y.encodeStateVector(this.doc)),
        ];
      case 'step2':
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

  encodeAwareness(update: Uint8Array): Uint8Array {
    return encodeAwareness(update);
  }
}
