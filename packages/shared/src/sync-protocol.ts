// Wire format for board synchronization. This is the y-protocols v1 framing: every message is a
// varint outer type followed by its payload. Sync messages carry their own inner sub-type.
//
// The codec is written here, rather than taken from y-protocols, so the server and the browser use
// one definition and the frames can be tested without the Yjs runtime. Payloads that are Yjs
// updates are opaque bytes to this module.

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
// Server-to-client only: the update with this sequence number is stored durably. This is an
// InkRoom extension; y-protocols does not define it.
export const MESSAGE_ACK = 2;
// Server-to-client only: the connection's current role on the board. Sent when the role changes
// while the connection is open, so the editor can switch to read-only without reconnecting.
export const MESSAGE_ROLE = 3;

export const SYNC_STEP1 = 0;
export const SYNC_STEP2 = 1;
export const SYNC_UPDATE = 2;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

// A growable byte writer with the varint encoding used by lib0 (the encoding Yjs uses).
export class Encoder {
  private bytes: number[] = [];

  writeVarUint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ProtocolError(`cannot encode ${value} as an unsigned varint`);
    }
    let remaining = value;
    while (remaining > 0x7f) {
      this.bytes.push(0x80 | (remaining & 0x7f));
      remaining = Math.floor(remaining / 128);
    }
    this.bytes.push(remaining);
  }

  writeVarBytes(data: Uint8Array): void {
    this.writeVarUint(data.length);
    for (const byte of data) {
      this.bytes.push(byte);
    }
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

export class Decoder {
  private position = 0;

  constructor(private readonly data: Uint8Array) {}

  readVarUint(): number {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 10; index += 1) {
      const byte = this.readByte();
      value += (byte & 0x7f) * multiplier;
      if (byte < 0x80) {
        if (!Number.isSafeInteger(value)) {
          throw new ProtocolError('varint is out of range');
        }
        return value;
      }
      multiplier *= 128;
    }
    throw new ProtocolError('varint is too long');
  }

  readVarBytes(maxLength: number): Uint8Array {
    const length = this.readVarUint();
    if (length > maxLength) {
      throw new ProtocolError(`payload of ${length} bytes exceeds the limit of ${maxLength}`);
    }
    if (this.position + length > this.data.length) {
      throw new ProtocolError('payload is truncated');
    }
    const slice = this.data.subarray(this.position, this.position + length);
    this.position += length;
    return slice;
  }

  hasContent(): boolean {
    return this.position < this.data.length;
  }

  private readByte(): number {
    const byte = this.data[this.position];
    if (byte === undefined) {
      throw new ProtocolError('message is truncated');
    }
    this.position += 1;
    return byte;
  }
}

export type SyncMessage =
  | { kind: 'step1'; stateVector: Uint8Array }
  | { kind: 'step2'; update: Uint8Array }
  | { kind: 'update'; update: Uint8Array };

export type ClientMessage =
  | { kind: 'sync'; sync: SyncMessage }
  | { kind: 'awareness'; update: Uint8Array }
  | { kind: 'ack'; seq: number }
  | { kind: 'role'; role: string };

export function encodeSyncStep1(stateVector: Uint8Array): Uint8Array {
  const encoder = new Encoder();
  encoder.writeVarUint(MESSAGE_SYNC);
  encoder.writeVarUint(SYNC_STEP1);
  encoder.writeVarBytes(stateVector);
  return encoder.toUint8Array();
}

export function encodeSyncStep2(update: Uint8Array): Uint8Array {
  const encoder = new Encoder();
  encoder.writeVarUint(MESSAGE_SYNC);
  encoder.writeVarUint(SYNC_STEP2);
  encoder.writeVarBytes(update);
  return encoder.toUint8Array();
}

export function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const encoder = new Encoder();
  encoder.writeVarUint(MESSAGE_SYNC);
  encoder.writeVarUint(SYNC_UPDATE);
  encoder.writeVarBytes(update);
  return encoder.toUint8Array();
}

export function encodeRole(role: string): Uint8Array {
  const encoder = new Encoder();
  encoder.writeVarUint(MESSAGE_ROLE);
  encoder.writeVarBytes(new TextEncoder().encode(role));
  return encoder.toUint8Array();
}

export function encodeAck(seq: number): Uint8Array {
  const encoder = new Encoder();
  encoder.writeVarUint(MESSAGE_ACK);
  encoder.writeVarUint(seq);
  return encoder.toUint8Array();
}

export function encodeAwareness(update: Uint8Array): Uint8Array {
  const encoder = new Encoder();
  encoder.writeVarUint(MESSAGE_AWARENESS);
  encoder.writeVarBytes(update);
  return encoder.toUint8Array();
}

// Decodes one frame. `maxPayloadBytes` bounds every embedded byte string, so an oversized frame is
// rejected before its contents are copied anywhere.
export function decodeClientMessage(frame: Uint8Array, maxPayloadBytes: number): ClientMessage {
  const decoder = new Decoder(frame);
  const message = readMessage(decoder, maxPayloadBytes);
  if (decoder.hasContent()) {
    throw new ProtocolError('message has trailing bytes');
  }
  return message;
}

function readMessage(decoder: Decoder, maxPayloadBytes: number): ClientMessage {
  const outer = decoder.readVarUint();

  if (outer === MESSAGE_SYNC) {
    const inner = decoder.readVarUint();
    const payload = decoder.readVarBytes(maxPayloadBytes);
    if (inner === SYNC_STEP1) {
      return { kind: 'sync', sync: { kind: 'step1', stateVector: payload } };
    }
    if (inner === SYNC_STEP2) {
      return { kind: 'sync', sync: { kind: 'step2', update: payload } };
    }
    if (inner === SYNC_UPDATE) {
      return { kind: 'sync', sync: { kind: 'update', update: payload } };
    }
    throw new ProtocolError(`unknown sync message type ${inner}`);
  }

  if (outer === MESSAGE_AWARENESS) {
    return { kind: 'awareness', update: decoder.readVarBytes(maxPayloadBytes) };
  }

  if (outer === MESSAGE_ROLE) {
    return { kind: 'role', role: new TextDecoder().decode(decoder.readVarBytes(64)) };
  }

  if (outer === MESSAGE_ACK) {
    return { kind: 'ack', seq: decoder.readVarUint() };
  }

  throw new ProtocolError(`unknown message type ${outer}`);
}
