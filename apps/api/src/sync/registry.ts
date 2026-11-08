import { Room, type RoomConnection, type RoomLimits } from './room';

// Holds one room per board that has at least one connection. A room is created on the first join
// and destroyed when its last connection leaves, so idle boards hold no memory.
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly limits: RoomLimits;
  private readonly now: () => number;

  constructor(limits: RoomLimits, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
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

  join(boardId: string, connection: RoomConnection): Room | null {
    const room = this.rooms.get(boardId) ?? new Room(boardId, this.limits, this.now);
    const result = room.join(connection);
    if (!result.ok) {
      if (room.size === 0) {
        room.destroy();
      }
      return null;
    }
    this.rooms.set(boardId, room);
    return room;
  }

  // Removes a connection from its board's room, and destroys the room if it is now empty.
  leave(boardId: string, connectionId: string): void {
    const room = this.rooms.get(boardId);
    if (!room) {
      return;
    }
    room.leave(connectionId);
    if (room.size === 0) {
      room.destroy();
      this.rooms.delete(boardId);
    }
  }

  find(boardId: string): Room | undefined {
    return this.rooms.get(boardId);
  }

  destroyAll(): void {
    for (const room of this.rooms.values()) {
      room.destroy();
    }
    this.rooms.clear();
  }
}
