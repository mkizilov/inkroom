import { describe, expect, it } from 'vitest';
import {
  Awareness,
  MAX_AWARENESS_STATE_BYTES,
  ProtocolError,
  decodeAwarenessEntries,
  encodeAwarenessEntries,
} from './index';

const user = (id: string) => ({
  user: { id, name: id, color: '#1971c2' },
  cursor: null,
  selection: [],
});

// Delivers one client's outgoing awareness bodies to another client, as the server relay does.
function relay(from: Awareness, to: Awareness): void {
  from.onLocalChange((body) => to.applyUpdate(body));
}

describe('awareness codec', () => {
  it('round-trips entries, including removals', () => {
    const entries = [
      { clientId: 7, clock: 3, json: '{"a":1}' },
      { clientId: 9, clock: 1, json: null },
    ];
    const decoded = decodeAwarenessEntries(encodeAwarenessEntries(entries), 4096);
    expect(decoded).toEqual(entries);
  });

  it('rejects a state larger than the limit', () => {
    const big = { clientId: 1, clock: 1, json: 'x'.repeat(MAX_AWARENESS_STATE_BYTES + 1) };
    expect(() =>
      decodeAwarenessEntries(encodeAwarenessEntries([big]), MAX_AWARENESS_STATE_BYTES),
    ).toThrow(ProtocolError);
  });

  it('rejects a payload with trailing bytes', () => {
    const body = encodeAwarenessEntries([{ clientId: 1, clock: 1, json: null }]);
    expect(() => decodeAwarenessEntries(new Uint8Array([...body, 0]), 4096)).toThrow(/trailing/);
  });

  it('rejects a state that is not valid UTF-8', () => {
    const body = new Uint8Array([1, 1, 1, 2, 0xff, 0xfe]);
    expect(() => decodeAwarenessEntries(body, 4096)).toThrow(/UTF-8/);
  });
});

describe('local awareness', () => {
  it('publishes each change to the local listeners and bumps the version', () => {
    const awareness = new Awareness();
    const published: Uint8Array[] = [];
    awareness.onLocalChange((body) => published.push(body));
    const before = awareness.version;

    awareness.setLocalState(user('a'));

    expect(published).toHaveLength(1);
    expect(awareness.version).toBeGreaterThan(before);
    expect(awareness.getLocalState()).toEqual(user('a'));
  });

  it('refreshes the local state with a newer clock as a heartbeat', () => {
    const awareness = new Awareness();
    awareness.setLocalState(user('a'));
    const first = awareness.encodeLocal();
    const published: Uint8Array[] = [];
    awareness.onLocalChange((body) => published.push(body));

    awareness.refresh();

    expect(published).toHaveLength(1);
    const [entry] = decodeAwarenessEntries(published[0] as Uint8Array, 4096);
    const [previous] = decodeAwarenessEntries(first, 4096);
    expect(entry?.clock).toBeGreaterThan(previous?.clock ?? 0);
  });

  it('does not heartbeat a removed participant', () => {
    const awareness = new Awareness();
    awareness.setLocalState(null);
    const published: Uint8Array[] = [];
    awareness.onLocalChange((body) => published.push(body));

    awareness.refresh();

    expect(published).toEqual([]);
  });

  it('ignores echoes of its own state', () => {
    const awareness = new Awareness();
    awareness.setLocalState(user('me'));
    const echo = awareness.encodeLocal();

    awareness.applyUpdate(echo);

    expect(awareness.remoteStates()).toEqual([]);
  });
});

describe('remote awareness', () => {
  it('shows a remote participant once its state arrives', () => {
    const alice = new Awareness();
    const bob = new Awareness();
    relay(alice, bob);

    alice.setLocalState(user('alice'));

    expect(bob.remoteStates()).toEqual([{ clientId: alice.clientID, state: user('alice') }]);
  });

  it('replaces a state only with a newer clock, so reordered frames cannot undo a move', () => {
    const bob = new Awareness();
    const newer = encodeAwarenessEntries([
      { clientId: 5, clock: 4, json: JSON.stringify({ n: 'newer' }) },
    ]);
    const older = encodeAwarenessEntries([
      { clientId: 5, clock: 3, json: JSON.stringify({ n: 'older' }) },
    ]);

    bob.applyUpdate(newer);
    bob.applyUpdate(older);

    expect(bob.remoteStates()).toEqual([{ clientId: 5, state: { n: 'newer' } }]);
  });

  it('removes a participant when a newer removal arrives, and not for an older one', () => {
    const bob = new Awareness();
    bob.applyUpdate(encodeAwarenessEntries([{ clientId: 5, clock: 2, json: '{"x":1}' }]));

    bob.applyUpdate(encodeAwarenessEntries([{ clientId: 5, clock: 2, json: null }]));
    expect(bob.remoteStates()).toHaveLength(1);

    bob.applyUpdate(encodeAwarenessEntries([{ clientId: 5, clock: 3, json: null }]));
    expect(bob.remoteStates()).toEqual([]);
  });

  it('drops remote participants that have not been refreshed within the timeout', () => {
    let now = 0;
    const bob = new Awareness({ now: () => now, outdatedTimeoutMs: 30_000 });
    bob.applyUpdate(encodeAwarenessEntries([{ clientId: 5, clock: 1, json: '{"x":1}' }]));

    now = 29_999;
    expect(bob.expireOutdated()).toEqual([]);
    now = 30_001;
    expect(bob.expireOutdated()).toEqual([5]);
    expect(bob.remoteStates()).toEqual([]);
  });

  it('keeps a participant that keeps refreshing', () => {
    let now = 0;
    const bob = new Awareness({ now: () => now, outdatedTimeoutMs: 30_000 });
    for (let tick = 1; tick <= 5; tick += 1) {
      now = tick * 20_000;
      bob.applyUpdate(encodeAwarenessEntries([{ clientId: 5, clock: tick, json: '{"x":1}' }]));
      expect(bob.expireOutdated()).toEqual([]);
    }
    expect(bob.remoteStates()).toHaveLength(1);
  });

  it('forgets every remote participant when the connection is lost', () => {
    const bob = new Awareness();
    bob.applyUpdate(encodeAwarenessEntries([{ clientId: 5, clock: 1, json: '{"x":1}' }]));
    bob.applyUpdate(encodeAwarenessEntries([{ clientId: 6, clock: 1, json: '{"x":2}' }]));

    bob.removeRemoteStates();

    expect(bob.remoteStates()).toEqual([]);
  });

  it('rejects a malformed body without changing the known participants', () => {
    const bob = new Awareness();
    bob.applyUpdate(encodeAwarenessEntries([{ clientId: 5, clock: 1, json: '{"x":1}' }]));

    expect(() => bob.applyUpdate(new Uint8Array([9, 9]))).toThrow(ProtocolError);
    expect(bob.remoteStates()).toHaveLength(1);
  });
});

describe('several participants', () => {
  it('converge on the same view of every participant, whatever the arrival order', () => {
    const clients = [new Awareness(), new Awareness(), new Awareness(), new Awareness()];
    const bodies: Uint8Array[] = [];
    clients.forEach((client, index) => {
      client.setLocalState(user(`user-${index}`));
      client.setLocalState(user(`user-${index}-moved`));
      client.onLocalChange((body) => bodies.push(body));
    });
    clients.forEach((client) => client.refresh());

    const observers = [new Awareness(), new Awareness()];
    for (const body of [...bodies].reverse()) {
      for (const observer of observers) observer.applyUpdate(body);
    }

    const view = (awareness: Awareness) =>
      awareness
        .remoteStates()
        .map((entry) => `${entry.clientId}:${JSON.stringify(entry.state)}`)
        .sort();
    const [first, second] = observers;
    expect(view(first as Awareness)).toEqual(view(second as Awareness));
    expect(view(first as Awareness)).toHaveLength(4);
    expect(view(first as Awareness).join(' ')).toContain('user-0-moved');
  });

  it('gives a late joiner the states it did not see, once the server sends its snapshot', () => {
    const alice = new Awareness();
    const bob = new Awareness();
    alice.setLocalState(user('alice'));
    const snapshot = alice.encodeLocal();
    const late = new Awareness();

    late.applyUpdate(snapshot);

    expect(late.remoteStates()).toEqual([{ clientId: alice.clientID, state: user('alice') }]);
    bob.setLocalState(user('bob'));
    late.applyUpdate(bob.encodeLocal());
    expect(late.remoteStates()).toHaveLength(2);
  });

  it('gives a reconnecting participant a fresh id, so peers accept its new states', () => {
    const alice = new Awareness();
    const bob = new Awareness();
    relay(alice, bob);
    alice.setLocalState(user('alice'));
    bob.applyUpdate(encodeAwarenessEntries([{ clientId: alice.clientID, clock: 9, json: null }]));

    const previous = alice.clientID;
    alice.rotateClientId();
    alice.setLocalState(user('alice'));

    expect(alice.clientID).not.toBe(previous);
    expect(bob.remoteStates().map((entry) => entry.clientId)).toEqual([alice.clientID]);
  });
});
