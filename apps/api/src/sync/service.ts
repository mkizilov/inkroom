import { randomUUID } from 'node:crypto';
import { ProtocolError, type AuthUser, type BoardRole } from '@inkroom/shared';
import type { DbExecutor } from '../db/client';
import { getBoardRole } from '../db/repositories/boards';
import { AuthorizationError, BoardNotFoundError, type BoardStore } from '../persistence/store';
import {
  CLOSE_GOING_AWAY,
  CLOSE_INTERNAL_ERROR,
  CLOSE_NORMAL,
  CLOSE_POLICY_VIOLATION,
  SyncConnection,
  UserConnectionCounter,
  type ConnectionLimits,
  type SocketLike,
} from './connections';
import { RoomRegistry } from './registry';
import { DEFAULT_ROOM_LIMITS, type RoomLimits } from './room';

export const REVOKED_REASON = 'access revoked';
export const BOARD_DELETED_REASON = 'board was deleted';

export interface Logger {
  error(obj: object, message: string): void;
  warn(obj: object, message: string): void;
}

export type OpenResult =
  | { ok: true; connection: SyncConnection }
  | { ok: false; code: number; reason: string };

export interface SyncServiceOptions {
  db: DbExecutor;
  store: BoardStore;
  roomLimits?: Partial<RoomLimits>;
  connectionLimits: ConnectionLimits;
  // Compact a board after this many stored updates from one room. Default 200.
  compactEvery?: number;
  // Compact every board with more than this many stored updates. Default 500.
  sweepThreshold?: number;
  // Interval for the sweep. Default 5 minutes. Zero disables the sweep.
  sweepIntervalMs?: number;
  // How often every open connection's membership is re-read from the database. This is what picks
  // up changes made by another process. Default 30 seconds. Zero disables it.
  membershipCheckMs?: number;
  logger: Logger;
  now?: () => number;
}

// Owns every live sync connection. The Fastify route authenticates the user and calls `open`;
// frames, pongs and closes then go through this service. Background work (compaction) is tracked
// here so shutdown can wait for it.
//
// Permissions are enforced in three places. The database checks the writer's role inside each
// write, so a revoked user cannot write even from a process that has not heard of the change. The
// room drops changes from read-only connections. And this service keeps each open connection's
// role current: a change made in this process is applied at once, and a periodic reconcile catches
// changes made elsewhere.
export class SyncService {
  private readonly db: DbExecutor;
  private readonly store: BoardStore;
  private readonly rooms: RoomRegistry;
  private readonly users: UserConnectionCounter;
  private readonly connections = new Map<string, SyncConnection>();
  private readonly limits: ConnectionLimits;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sweepThreshold: number;
  private readonly sweepIntervalMs: number;
  private readonly membershipCheckMs: number;
  private readonly background = new Set<Promise<void>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private sweep: ReturnType<typeof setInterval> | null = null;
  private membershipCheck: ReturnType<typeof setInterval> | null = null;

  constructor(options: SyncServiceOptions) {
    this.db = options.db;
    this.store = options.store;
    this.limits = options.connectionLimits;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.sweepThreshold = options.sweepThreshold ?? 500;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 5 * 60 * 1000;
    this.membershipCheckMs = options.membershipCheckMs ?? 30_000;
    this.rooms = new RoomRegistry({
      store: options.store,
      limits: { ...DEFAULT_ROOM_LIMITS, ...options.roomLimits },
      compactEvery: options.compactEvery ?? 200,
      now: this.now,
      track: (work) => this.track(work),
    });
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
    return this.rooms.roomFor(boardId);
  }

  // Checks the board, the user's connection budget and the room's capacity, then joins the room.
  // Access is checked after authentication, so a non-member gets the same answer as a missing board.
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
      role,
      socket: input.socket,
      limits: this.limits,
      now: this.now,
      onClosed: (closed) => this.forget(closed),
    });

    let joined: Awaited<ReturnType<RoomRegistry['join']>>;
    try {
      joined = await this.rooms.join(input.boardId, connection);
    } catch (error) {
      this.users.release(input.user.id);
      if (error instanceof BoardNotFoundError) {
        return { ok: false, code: CLOSE_POLICY_VIOLATION, reason: 'board not found' };
      }
      this.logger.error({ err: error, boardId: input.boardId }, 'could not load board for sync');
      return { ok: false, code: CLOSE_INTERNAL_ERROR, reason: 'the board could not be loaded' };
    }
    if (!joined.ok) {
      this.users.release(input.user.id);
      const reason = joined.reason === 'full' ? 'board is full' : 'board is closing';
      return { ok: false, code: CLOSE_POLICY_VIOLATION, reason };
    }
    this.connections.set(connection.id, connection);

    // The role was read before the join. A change committed in between is caught here: the join is
    // already registered, so any later change reaches this connection through applyMembership.
    const current = await getBoardRole(this.db, input.boardId, input.user.id);
    if (!current) {
      connection.close(CLOSE_POLICY_VIOLATION, REVOKED_REASON);
      return { ok: false, code: CLOSE_POLICY_VIOLATION, reason: REVOKED_REASON };
    }
    connection.setRole(current);
    return { ok: true, connection };
  }

  // Handles one incoming frame. A frame that breaks the rules closes its connection, and nothing
  // else is affected. The returned promise settles once the frame has been stored and applied, or
  // refused; it never rejects.
  receive(connection: SyncConnection, frame: Uint8Array): Promise<void> {
    if (connection.isClosed || !connection.checkFrameSize(frame.byteLength)) {
      return Promise.resolve();
    }
    const room = this.rooms.roomFor(connection.boardId);
    if (!room || !room.has(connection.id)) {
      connection.close(CLOSE_GOING_AWAY, 'room is gone');
      return Promise.resolve();
    }
    return room.receive(connection.id, frame).catch((error: unknown) => {
      this.failConnection(connection, error);
    });
  }

  // Applies a change that the store has already written (a restore) to the live room, if there is
  // one. Rooms that are not loaded pick the change up from the store when they load.
  async applyPersisted(boardId: string, update: Uint8Array): Promise<void> {
    await this.rooms.roomFor(boardId)?.applyPersisted(update);
  }

  // Brings this process's connections of one user on one board into line with a membership change.
  // A null role means the membership was removed, and the connections are closed. Any other role
  // is applied at once, and the client is told.
  applyMembership(boardId: string, userId: string, role: BoardRole | null): void {
    for (const connection of [...this.connections.values()]) {
      if (connection.boardId !== boardId || connection.userId !== userId) {
        continue;
      }
      if (role === null) {
        connection.close(CLOSE_POLICY_VIOLATION, REVOKED_REASON);
      } else {
        connection.setRole(role);
      }
    }
  }

  // Closes every connection to a board that has been deleted.
  boardDeleted(boardId: string): void {
    for (const connection of [...this.connections.values()]) {
      if (connection.boardId === boardId) {
        connection.close(CLOSE_POLICY_VIOLATION, BOARD_DELETED_REASON);
      }
    }
  }

  // Re-reads the role of every open connection from the database, and applies what it finds. Used
  // for changes this process did not make, so their effect is bounded by the check interval.
  async reconcileMemberships(): Promise<void> {
    for (const connection of [...this.connections.values()]) {
      if (connection.isClosed) {
        continue;
      }
      const role = await getBoardRole(this.db, connection.boardId, connection.userId);
      if (connection.isClosed) {
        continue;
      }
      if (!role) {
        connection.close(CLOSE_POLICY_VIOLATION, REVOKED_REASON);
      } else {
        connection.setRole(role);
      }
    }
  }

  // Starts the heartbeat. Every interval it pings each connection and drops any that have not
  // answered within the timeout.
  startHeartbeat(): void {
    if (this.heartbeat) {
      return;
    }
    this.heartbeat = setInterval(() => {
      for (const room of this.rooms.all()) {
        room.expirePresence();
      }
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

  // Starts the periodic membership check. See reconcileMemberships.
  startMembershipCheck(): void {
    if (this.membershipCheck || this.membershipCheckMs <= 0) {
      return;
    }
    this.membershipCheck = setInterval(() => {
      this.track(this.reconcileMemberships());
    }, this.membershipCheckMs);
    this.membershipCheck.unref();
  }

  // Starts the periodic compaction sweep, which catches boards left with many updates by a crash.
  startSweep(): void {
    if (this.sweep || this.sweepIntervalMs <= 0) {
      return;
    }
    this.sweep = setInterval(() => {
      this.track(this.runSweep());
    }, this.sweepIntervalMs);
    this.sweep.unref();
  }

  // Closes every connection, releases the rooms, and waits for background work to finish. Rooms
  // compact their pending updates on release, so this also leaves the stored log compacted.
  async shutdown(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.sweep) {
      clearInterval(this.sweep);
      this.sweep = null;
    }
    if (this.membershipCheck) {
      clearInterval(this.membershipCheck);
      this.membershipCheck = null;
    }
    for (const connection of [...this.connections.values()]) {
      connection.close(CLOSE_NORMAL, 'server is shutting down');
    }
    this.rooms.destroyAll();
    await Promise.allSettled([...this.background]);
  }

  private async runSweep(): Promise<void> {
    const result = await this.store.compactDue(this.sweepThreshold);
    for (const failure of result.failed) {
      this.logger.error({ err: failure.error, boardId: failure.boardId }, 'compaction failed');
    }
  }

  // Runs background work so that its failure is logged, and so that shutdown can wait for it.
  private track(work: Promise<unknown>): void {
    const tracked: Promise<void> = work
      .then(
        () => undefined,
        (error: unknown) => {
          this.logger.error({ err: error }, 'background task failed');
        },
      )
      .finally(() => {
        this.background.delete(tracked);
      });
    this.background.add(tracked);
  }

  private failConnection(connection: SyncConnection, error: unknown): void {
    if (error instanceof ProtocolError) {
      connection.close(CLOSE_POLICY_VIOLATION, error.message);
      return;
    }
    if (error instanceof AuthorizationError) {
      // The database refused the write: the role no longer allows it. The connection is closed.
      connection.close(CLOSE_POLICY_VIOLATION, 'not permitted to change this board');
      return;
    }
    if (error instanceof BoardNotFoundError) {
      connection.close(CLOSE_POLICY_VIOLATION, BOARD_DELETED_REASON);
      return;
    }
    // The update was not stored, so it is not applied or acknowledged. The client keeps it and
    // sends it again on reconnect.
    this.logger.error({ err: error, boardId: connection.boardId }, 'sync update was not stored');
    connection.close(CLOSE_INTERNAL_ERROR, 'the update could not be saved');
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
