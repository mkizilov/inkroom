import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@inkroom/shared';
import type { DbExecutor } from '../db/client';
import { getBoardRole } from '../db/repositories/boards';
import {
  CLOSE_GOING_AWAY,
  CLOSE_NORMAL,
  CLOSE_POLICY_VIOLATION,
  SyncConnection,
  UserConnectionCounter,
  type ConnectionLimits,
  type SocketLike,
} from './connections';
import { ProtocolError } from '@inkroom/shared';
import { RoomRegistry } from './registry';
import type { RoomLimits } from './room';

export type OpenResult =
  | { ok: true; connection: SyncConnection }
  | { ok: false; code: number; reason: string };

export interface SyncServiceOptions {
  db: DbExecutor;
  roomLimits: RoomLimits;
  connectionLimits: ConnectionLimits;
  now?: () => number;
}

// Owns every live sync connection. The Fastify route authenticates the user and calls `open`;
// everything after that (frames, pongs, closes, heartbeats) goes through this service.
export class SyncService {
  private readonly db: DbExecutor;
  private readonly rooms: RoomRegistry;
  private readonly users: UserConnectionCounter;
  private readonly connections = new Map<string, SyncConnection>();
  private readonly limits: ConnectionLimits;
  private readonly now: () => number;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(options: SyncServiceOptions) {
    this.db = options.db;
    this.limits = options.connectionLimits;
    this.now = options.now ?? Date.now;
    this.rooms = new RoomRegistry(options.roomLimits, this.now);
    this.users = new UserConnectionCounter(options.connectionLimits.maxConnectionsPerUser);
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  get roomCount(): number {
    return this.rooms.roomCount;
  }

  // The live room for a board, or undefined when nobody is connected to it.
  roomFor(boardId: string) {
    return this.rooms.find(boardId);
  }

  // Checks the board, the user's connection budget and the room's capacity, then joins the room
  // and sends the state vector. Access is checked here, after authentication, so a member of a
  // different board gets the same 404 as for a board that does not exist.
  async open(input: { user: AuthUser; boardId: string; socket: SocketLike }): Promise<OpenResult> {
    const role = await getBoardRole(this.db, input.boardId, input.user.id);
    if (!role) {
      return { ok: false, code: CLOSE_POLICY_VIOLATION, reason: 'board not found' };
    }
    if (!this.users.tryAcquire(input.user.id)) {
      return { ok: false, code: CLOSE_POLICY_VIOLATION, reason: 'too many connections' };
    }

    const connection = new SyncConnection({
      id: randomUUID(),
      userId: input.user.id,
      boardId: input.boardId,
      readOnly: role === 'viewer',
      socket: input.socket,
      limits: this.limits,
      now: this.now,
      onClosed: (closed) => this.forget(closed),
    });

    const room = this.rooms.join(input.boardId, connection);
    if (!room) {
      this.users.release(input.user.id);
      return { ok: false, code: CLOSE_POLICY_VIOLATION, reason: 'board is full' };
    }
    this.connections.set(connection.id, connection);
    return { ok: true, connection };
  }

  // Handles one incoming frame. A frame that breaks the rules closes its connection, and nothing
  // else is affected.
  receive(connection: SyncConnection, frame: Uint8Array): void {
    if (connection.isClosed || !connection.checkFrameSize(frame.byteLength)) {
      return;
    }
    const room = this.rooms.find(connection.boardId);
    if (!room) {
      connection.close(CLOSE_GOING_AWAY, 'room is gone');
      return;
    }
    try {
      room.receive(connection.id, frame);
    } catch (error) {
      const reason = error instanceof ProtocolError ? error.message : 'invalid message';
      connection.close(CLOSE_POLICY_VIOLATION, reason);
    }
  }

  // Starts the heartbeat. Every interval it pings each connection and drops any that have not
  // answered within the timeout. Dropping a connection removes its presence and its room slot.
  startHeartbeat(): void {
    if (this.heartbeat) {
      return;
    }
    this.heartbeat = setInterval(() => {
      for (const connection of [...this.connections.values()]) {
        if (connection.isStale()) {
          connection.close(CLOSE_GOING_AWAY, 'no response to heartbeat');
        } else {
          connection.ping();
        }
      }
    }, this.limits.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  // Shuts down every connection and stops the heartbeat. Used by the server on exit.
  shutdown(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const connection of [...this.connections.values()]) {
      connection.close(CLOSE_NORMAL, 'server is shutting down');
    }
    this.rooms.destroyAll();
  }

  // Removes a connection's bookkeeping. Called exactly once for each connection, from its close.
  private forget(connection: SyncConnection): void {
    if (!this.connections.delete(connection.id)) {
      return;
    }
    this.users.release(connection.userId);
    this.rooms.leave(connection.boardId, connection.id);
  }
}

