import { Decoder, Encoder, ProtocolError } from './sync-protocol';

// Ephemeral presence (cursors, names, selections). This follows the Yjs awareness model: each
// participant owns a numeric client id, every state carries a clock, a newer clock replaces an
// older one, and a state of null removes the participant. Presence is never written to storage.

export const MAX_AWARENESS_STATE_BYTES = 4096;
export const MAX_AWARENESS_ENTRIES = 1000;

// One participant's state. `json` is the JSON text of the state, or null for a removal.
export interface AwarenessEntry {
  clientId: number;
  clock: number;
  json: string | null;
}

const REMOVED = 'null';

export function encodeAwarenessEntries(entries: readonly AwarenessEntry[]): Uint8Array {
  const encoder = new Encoder();
  encoder.writeVarUint(entries.length);
  const text = new TextEncoder();
  for (const entry of entries) {
    encoder.writeVarUint(entry.clientId);
    encoder.writeVarUint(entry.clock);
    encoder.writeVarBytes(text.encode(entry.json ?? REMOVED));
  }
  return encoder.toUint8Array();
}

// Decodes an awareness body strictly: a malformed body, an oversized state or trailing bytes throw
// a ProtocolError. The JSON is not parsed here; callers validate it against the presence schema.
export function decodeAwarenessEntries(
  payload: Uint8Array,
  maxStateBytes: number,
): AwarenessEntry[] {
  const decoder = new Decoder(payload);
  const count = decoder.readVarUint();
  if (count > MAX_AWARENESS_ENTRIES) {
    throw new ProtocolError('too many awareness entries');
  }
  const entries: AwarenessEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const clientId = decoder.readVarUint();
    const clock = decoder.readVarUint();
    const text = decodeUtf8(decoder.readVarBytes(maxStateBytes));
    entries.push({ clientId, clock, json: text === REMOVED ? null : text });
  }
  if (decoder.hasContent()) {
    throw new ProtocolError('awareness payload has trailing bytes');
  }
  return entries;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ProtocolError('awareness state is not UTF-8');
  }
}

export interface AwarenessOptions {
  now?: () => number;
  // A remote participant whose state has not been refreshed for this long is dropped locally.
  outdatedTimeoutMs?: number;
}

const DEFAULT_OUTDATED_TIMEOUT_MS = 30_000;

type Listener = () => void;

interface RemoteState {
  state: unknown;
  clock: number;
  updatedAt: number;
}

// The presence of every participant this client knows about, including this client's own state.
// `version` changes whenever anything visible changes, so a view can detect changes cheaply.
export class Awareness {
  clientID: number;
  version = 0;
  private clock = 0;
  private localState: unknown | null = null;
  private readonly remote = new Map<number, RemoteState>();
  private readonly lastClock = new Map<number, number>();
  private readonly changeListeners = new Set<Listener>();
  private readonly localListeners = new Set<(body: Uint8Array) => void>();
  private readonly now: () => number;
  private readonly outdatedTimeoutMs: number;

  constructor(options: AwarenessOptions = {}) {
    this.now = options.now ?? Date.now;
    this.outdatedTimeoutMs = options.outdatedTimeoutMs ?? DEFAULT_OUTDATED_TIMEOUT_MS;
    this.clientID = randomClientId();
  }

  // A new client id for a new connection. The server removes the old id when the connection
  // closes, and peers ignore any state with a clock they have already seen, so a fresh id starts
  // from clock zero and cannot be confused with the old one.
  rotateClientId(): void {
    this.clientID = randomClientId();
    this.clock = 0;
  }

  getLocalState(): unknown | null {
    return this.localState;
  }

  // Sets this participant's state and tells the other clients. A null state removes it.
  setLocalState(state: unknown | null): void {
    this.clock += 1;
    this.localState = state;
    this.changed();
    this.emitLocal(this.encodeLocal());
  }

  // Sends the current state again with a newer clock. Peers use this as a heartbeat, so a state is
  // not dropped as outdated while its participant is still connected and idle.
  refresh(): void {
    if (this.localState === null) {
      return;
    }
    this.clock += 1;
    this.emitLocal(this.encodeLocal());
  }

  // The local state as an awareness body, for sending on a fresh connection.
  encodeLocal(): Uint8Array {
    const json = this.localState === null ? null : JSON.stringify(this.localState);
    return encodeAwarenessEntries([{ clientId: this.clientID, clock: this.clock, json }]);
  }

  // Applies states received from the server. Our own id is ignored, and an entry is applied only
  // when its clock is newer than the last one seen for that participant.
  applyUpdate(body: Uint8Array): void {
    let changed = false;
    for (const entry of decodeAwarenessEntries(body, MAX_AWARENESS_STATE_BYTES)) {
      if (entry.clientId === this.clientID) {
        continue;
      }
      const last = this.lastClock.get(entry.clientId);
      if (last !== undefined && entry.clock <= last) {
        continue;
      }
      this.lastClock.set(entry.clientId, entry.clock);
      if (entry.json === null) {
        changed = this.remote.delete(entry.clientId) || changed;
        continue;
      }
      this.remote.set(entry.clientId, {
        state: JSON.parse(entry.json) as unknown,
        clock: entry.clock,
        updatedAt: this.now(),
      });
      changed = true;
    }
    if (changed) {
      this.changed();
    }
  }

  remoteStates(): Array<{ clientId: number; state: unknown }> {
    return [...this.remote].map(([clientId, entry]) => ({ clientId, state: entry.state }));
  }

  // Drops every remote participant. Used when this client loses its connection: nothing can refresh
  // their states while disconnected, and the server will send them again on reconnect.
  removeRemoteStates(): void {
    if (this.remote.size === 0) {
      return;
    }
    this.remote.clear();
    this.changed();
  }

  // Drops remote participants whose state has not been refreshed in time. Returns their ids.
  expireOutdated(): number[] {
    const cutoff = this.now() - this.outdatedTimeoutMs;
    const removed: number[] = [];
    for (const [clientId, entry] of this.remote) {
      if (entry.updatedAt < cutoff) {
        this.remote.delete(clientId);
        removed.push(clientId);
      }
    }
    if (removed.length > 0) {
      this.changed();
    }
    return removed;
  }

  // Subscribes to any visible change, local or remote.
  subscribe = (listener: Listener): (() => void) => {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  };

  // Subscribes to this client's own changes, as bodies ready to send. Remote changes are not
  // reported here, so nothing received is sent back.
  onLocalChange(listener: (body: Uint8Array) => void): () => void {
    this.localListeners.add(listener);
    return () => {
      this.localListeners.delete(listener);
    };
  }

  destroy(): void {
    this.changeListeners.clear();
    this.localListeners.clear();
    this.remote.clear();
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.changeListeners) {
      listener();
    }
  }

  private emitLocal(body: Uint8Array): void {
    for (const listener of this.localListeners) {
      listener(body);
    }
  }
}

function randomClientId(): number {
  // Positive 31-bit ids, so they encode as small varints and never collide with zero.
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}
