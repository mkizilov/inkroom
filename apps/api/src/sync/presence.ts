import {
  ProtocolError,
  presenceStateSchema,
  type AwarenessEntry,
} from '@inkroom/shared';

// Live presence for one room, held in memory only. It is never written to the database.
//
// Rules:
//   - A participant id belongs to the connection that first announced it. Another connection that
//     sends the same id is closed, since no honest client does that.
//   - A state is kept only if its clock is newer than the one held, the same rule clients apply.
//   - A non-null state must match the presence schema; anything else closes the sender.
//   - When a connection leaves, every id it held is removed for the others.
//   - A participant that has not refreshed within the timeout is removed, so a frozen tab does not
//     stay in the list forever.

export interface PresenceLimits {
  timeoutMs: number;
  // Most ids the room tracks, including removed ones still held by a connection.
  maxEntries: number;
}

export const DEFAULT_PRESENCE_LIMITS: PresenceLimits = {
  timeoutMs: 30_000,
  maxEntries: 200,
};

interface PresenceRecord {
  owner: string;
  clock: number;
  json: string | null;
  updatedAt: number;
}

export class PresenceRegistry {
  private readonly records = new Map<number, PresenceRecord>();
  private readonly limits: PresenceLimits;
  private readonly now: () => number;

  constructor(limits: PresenceLimits, now: () => number) {
    this.limits = limits;
    this.now = now;
  }

  // Validates entries from one connection and returns those that changed presence, to relay.
  accept(owner: string, entries: readonly AwarenessEntry[]): AwarenessEntry[] {
    const accepted: AwarenessEntry[] = [];
    for (const entry of entries) {
      const current = this.records.get(entry.clientId);
      if (current && current.owner !== owner) {
        throw new ProtocolError('presence id belongs to another connection');
      }
      if (current && entry.clock <= current.clock) {
        continue;
      }
      if (entry.json !== null) {
        validatePresence(entry.json);
      }
      if (!current && this.records.size >= this.limits.maxEntries) {
        throw new ProtocolError('too many participants on this board');
      }
      this.records.set(entry.clientId, {
        owner,
        clock: entry.clock,
        json: entry.json,
        updatedAt: this.now(),
      });
      accepted.push(entry);
    }
    return accepted;
  }

  // The states a newly joined client needs to see who is already here.
  snapshot(): AwarenessEntry[] {
    const entries: AwarenessEntry[] = [];
    for (const [clientId, record] of this.records) {
      if (record.json !== null) {
        entries.push({ clientId, clock: record.clock, json: record.json });
      }
    }
    return entries;
  }

  // Removes everything a connection held, and returns the removals to tell the others.
  release(owner: string): AwarenessEntry[] {
    const removals: AwarenessEntry[] = [];
    for (const [clientId, record] of [...this.records]) {
      if (record.owner === owner) {
        this.records.delete(clientId);
        removals.push({ clientId, clock: record.clock + 1, json: null });
      }
    }
    return removals;
  }

  // Removes participants whose state has gone stale, and returns the removals to relay. The removal
  // keeps the record with a higher clock. A participant that was expired and then resumes must
  // send a newer state than that clock, which its next heartbeat does.
  expire(): AwarenessEntry[] {
    const cutoff = this.now() - this.limits.timeoutMs;
    const removals: AwarenessEntry[] = [];
    for (const [clientId, record] of this.records) {
      if (record.json !== null && record.updatedAt < cutoff) {
        record.clock += 1;
        record.json = null;
        removals.push({ clientId, clock: record.clock, json: null });
      }
    }
    return removals;
  }

  get size(): number {
    return this.records.size;
  }
}

function validatePresence(json: string): void {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ProtocolError('presence state is not valid JSON');
  }
  if (!presenceStateSchema.safeParse(value).success) {
    throw new ProtocolError('presence state does not match the presence schema');
  }
}
