import type { BoardStore } from '../persistence/store';
import { Room, type RoomConnection, type RoomLimits } from './room';

export interface RegistryOptions {
  store: BoardStore;
  limits: RoomLimits;
  compactEvery: number;
  now: () => number;
  track: (work: Promise<unknown>) => void;
}

export type RegistryJoin = { ok: true; room: Room } | { ok: false; reason: 'full' | 'closed' };

// Holds one room per board that has at least one connection. A room is loaded from the store on the
// first join, and it is released when its last connection leaves. Concurrent first joins share one
// load, so a board is never loaded twice.
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly loading = new Map<string, Promise<Room>>();
  private readonly options: RegistryOptions;

  constructor(options: RegistryOptions) {
    this.options = options;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  get connectionCount(): number {
    let total = 0;
    for (const room of this.rooms.values()) {
      total += room.size;
    }
    return total;
  }

  // Every live room. Used by the heartbeat to expire stale presence.
  all(): Room[] {
    return [...this.rooms.values()];
  }

  // The live room for a board, or undefined when nobody is connected to it.
  roomFor(boardId: string): Room | undefined {
    return this.rooms.get(boardId);
  }

  async join(boardId: string, connection: RoomConnection): Promise<RegistryJoin> {
    const room = await this.acquire(boardId);
    const result = room.join(connection);
    if (!result.ok) {
      if (room.size === 0) {
        this.discard(boardId, room);
      }
      return result;
    }
    return { ok: true, room };
  }

  // Removes a connection from its board's room, and releases the room if it is now empty.
  leave(boardId: string, connectionId: string): void {
    const room = this.rooms.get(boardId);
    if (!room) {
      return;
    }
    room.leave(connectionId);
    if (room.size === 0) {
      this.discard(boardId, room);
    }
  }

  destroyAll(): void {
    for (const [boardId, room] of [...this.rooms]) {
      this.discard(boardId, room);
    }
  }

  private acquire(boardId: string): Promise<Room> {
    const live = this.rooms.get(boardId);
    if (live) {
      return Promise.resolve(live);
    }
    return this.loading.get(boardId) ?? this.start(boardId);
  }

  private start(boardId: string): Promise<Room> {
    const pending = this.open(boardId).finally(() => {
      this.loading.delete(boardId);
    });
    this.loading.set(boardId, pending);
    return pending;
  }

  private async open(boardId: string): Promise<Room> {
    const doc = await this.options.store.load(boardId);
    const room = new Room({
      boardId,
      doc,
      store: this.options.store,
      limits: this.options.limits,
      compactEvery: this.options.compactEvery,
      now: this.options.now,
      track: this.options.track,
    });
    this.rooms.set(boardId, room);
    return room;
  }

  private discard(boardId: string, room: Room): void {
    room.destroy();
    if (this.rooms.get(boardId) === room) {
      this.rooms.delete(boardId);
    }
  }
}
