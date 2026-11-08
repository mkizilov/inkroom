import { describe, expect, it } from 'vitest';
import {
  Decoder,
  Encoder,
  ProtocolError,
  decodeClientMessage,
  encodeAck,
  encodeAwareness,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
} from './sync-protocol';

const bytes = (...values: number[]) => Uint8Array.from(values);
const MAX = 1024;

describe('varint encoding', () => {
  it.each([
    [0, [0]],
    [127, [127]],
    [128, [0x80, 0x01]],
    [300, [0xac, 0x02]],
    [16_384, [0x80, 0x80, 0x01]],
  ])('encodes %i as the lib0 varint %j', (value, expected) => {
    const encoder = new Encoder();
    encoder.writeVarUint(value);
    expect(Array.from(encoder.toUint8Array())).toEqual(expected);
  });

  it('round-trips values across the boundaries and up to 2^53', () => {
    const values = [0, 1, 127, 128, 255, 16_383, 16_384, 2 ** 31, 2 ** 40, Number.MAX_SAFE_INTEGER];
    for (const value of values) {
      const encoder = new Encoder();
      encoder.writeVarUint(value);
      expect(new Decoder(encoder.toUint8Array()).readVarUint()).toBe(value);
    }
  });

  it('refuses to encode negative or non-integer values', () => {
    const encoder = new Encoder();
    expect(() => encoder.writeVarUint(-1)).toThrow(ProtocolError);
    expect(() => encoder.writeVarUint(1.5)).toThrow(ProtocolError);
  });

  it('rejects a varint that never terminates', () => {
    const tooLong = new Array<number>(11).fill(0x80);
    const decoder = new Decoder(bytes(...tooLong));
    expect(() => decoder.readVarUint()).toThrow(/too long/);
  });

  it('rejects a truncated varint', () => {
    expect(() => new Decoder(bytes(0x80)).readVarUint()).toThrow(/truncated/);
  });
});

describe('byte payloads', () => {
  it('refuses to read a payload longer than the limit', () => {
    const encoder = new Encoder();
    encoder.writeVarBytes(new Uint8Array(10));
    const decoder = new Decoder(encoder.toUint8Array());
    expect(() => decoder.readVarBytes(9)).toThrow(/exceeds the limit/);
  });

  it('refuses a declared length longer than the data', () => {
    const decoder = new Decoder(bytes(5, 1, 2));
    expect(() => decoder.readVarBytes(100)).toThrow(/truncated/);
  });
});

describe('client messages', () => {
  it('decodes a step 1 message with its state vector', () => {
    const frame = encodeSyncStep1(bytes(1, 2, 3));
    expect(decodeClientMessage(frame, MAX)).toEqual({
      kind: 'sync',
      sync: { kind: 'step1', stateVector: bytes(1, 2, 3) },
    });
  });

  it('decodes step 2 and update messages', () => {
    expect(decodeClientMessage(encodeSyncStep2(bytes(9)), MAX)).toEqual({
      kind: 'sync',
      sync: { kind: 'step2', update: bytes(9) },
    });
    expect(decodeClientMessage(encodeSyncUpdate(bytes(7, 7)), MAX)).toEqual({
      kind: 'sync',
      sync: { kind: 'update', update: bytes(7, 7) },
    });
  });

  it('decodes awareness messages', () => {
    expect(decodeClientMessage(encodeAwareness(bytes(4)), MAX)).toEqual({
      kind: 'awareness',
      update: bytes(4),
    });
  });

  it('round-trips every message type with an empty payload', () => {
    const frames = [
      encodeSyncStep1(new Uint8Array(0)),
      encodeSyncStep2(new Uint8Array(0)),
      encodeSyncUpdate(new Uint8Array(0)),
      encodeAwareness(new Uint8Array(0)),
    ];
    for (const frame of frames) {
      expect(() => decodeClientMessage(frame, MAX)).not.toThrow();
    }
  });

  it('rejects an unknown outer message type', () => {
    expect(() => decodeClientMessage(bytes(5, 0), MAX)).toThrow(/unknown message type 5/);
  });

  it('rejects an unknown sync sub-type', () => {
    expect(() => decodeClientMessage(bytes(0, 9, 0), MAX)).toThrow(/unknown sync message type 9/);
  });

  it('rejects a frame whose payload exceeds the limit before copying it', () => {
    const frame = encodeSyncUpdate(new Uint8Array(MAX + 1));
    expect(() => decodeClientMessage(frame, MAX)).toThrow(/exceeds the limit/);
  });

  it('rejects an empty frame', () => {
    expect(() => decodeClientMessage(new Uint8Array(0), MAX)).toThrow(/truncated/);
  });

  it('decodes a server acknowledgement with its sequence number', () => {
    expect(decodeClientMessage(encodeAck(123_456), MAX)).toEqual({ kind: 'ack', seq: 123_456 });
  });

  it('rejects trailing bytes after a complete message', () => {
    const padded = new Uint8Array([...encodeSyncUpdate(bytes(1)), 0xff]);
    expect(() => decodeClientMessage(padded, MAX)).toThrow(/trailing bytes/);
  });
});
