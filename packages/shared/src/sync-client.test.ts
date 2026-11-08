import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { SyncClient, carriesChanges } from './sync-client';
import {
  decodeClientMessage,
  encodeAck,
  encodeAwareness,
  encodeRole,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
} from './sync-protocol';

const REMOTE = Symbol('remote');
const LIMIT = 1024 * 1024;

function documentWith(key: string, value: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getMap('objects').set(key, value);
  return Y.encodeStateAsUpdate(doc);
}

describe('SyncClient role frames', () => {
  it('reports a role change to onRole, and answers it with nothing', () => {
    const roles: string[] = [];
    const client = new SyncClient({
      doc: new Y.Doc(),
      remoteOrigin: REMOTE,
      onRole: (role) => roles.push(role),
    });

    expect(client.receive(encodeRole('viewer'))).toEqual([]);
    expect(roles).toEqual(['viewer']);
  });
});

describe('SyncClient handshake', () => {
  it('answers a state vector with a step 2 only, so the exchange ends', () => {
    const client = new SyncClient({ doc: new Y.Doc(), remoteOrigin: REMOTE });
    const other = new Y.Doc();
    other.getMap('objects').set('k', 'v');

    const replies = client.receive(encodeSyncStep1(Y.encodeStateVector(other)));

    expect(replies).toHaveLength(1);
    const reply = decodeClientMessage(replies[0] as Uint8Array, LIMIT);
    expect(reply).toMatchObject({ kind: 'sync', sync: { kind: 'step2' } });
  });

  it('reports the end of the handshake when the server answers, and applies its state', () => {
    let handshakes = 0;
    const doc = new Y.Doc();
    const client = new SyncClient({
      doc,
      remoteOrigin: REMOTE,
      onHandshake: () => {
        handshakes += 1;
      },
    });

    client.receive(encodeSyncStep2(documentWith('from-server', 'hello')));

    expect(handshakes).toBe(1);
    expect(doc.getMap('objects').get('from-server')).toBe('hello');
  });

  it('reports each acknowledgement with its sequence number', () => {
    const seqs: number[] = [];
    const client = new SyncClient({
      doc: new Y.Doc(),
      remoteOrigin: REMOTE,
      onAck: (seq) => seqs.push(seq),
    });

    expect(client.receive(encodeAck(7))).toEqual([]);
    expect(seqs).toEqual([7]);
    expect(client.acknowledgedSeq).toBe(7);
  });

  it('ignores presence frames for the handshake callbacks', () => {
    let handshakes = 0;
    const client = new SyncClient({
      doc: new Y.Doc(),
      remoteOrigin: REMOTE,
      onHandshake: () => {
        handshakes += 1;
      },
    });

    client.receive(encodeAwareness(new Uint8Array()));

    expect(handshakes).toBe(0);
  });
});

describe('carriesChanges', () => {
  it('is true for an update that adds or deletes something', () => {
    const doc = new Y.Doc();
    doc.getMap('objects').set('a', 1);
    const added = encodeSyncUpdate(Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(doc);
    doc.getMap('objects').delete('a');
    // Nothing new was added after `before`, so only the deletion is in this update.
    const deleted = encodeSyncUpdate(Y.encodeStateAsUpdate(doc, before));

    expect(carriesChanges(added)).toBe(true);
    expect(carriesChanges(deleted)).toBe(true);
  });

  it('is false for an empty update, a state vector and a presence frame', () => {
    const empty = encodeSyncUpdate(Y.encodeStateAsUpdate(new Y.Doc()));

    expect(carriesChanges(empty)).toBe(false);
    expect(carriesChanges(encodeSyncStep1(Y.encodeStateVector(new Y.Doc())))).toBe(false);
    expect(carriesChanges(encodeAwareness(new Uint8Array()))).toBe(false);
  });
});
