import type { RoomConnection } from './room';

// The part of a WebSocket that the sync service uses. The Fastify route adapts a real socket to
// this shape, so the policy below can be tested without a network.
export interface SocketLike {
  send(data: Uint8Array): void;
  ping(): void;
  close(code: number, reason: string): void;
  terminate(): void;
  readonly bufferedAmount: number;
  readonly readyState: 'open' | 'closed';
}

export interface ConnectionLimits {
  // Frames above this size close the connection with 1009 (message too big).
  maxFrameBytes: number;
  // A socket whose outgoing buffer grows past this is treated as stalled and dropped.
  maxBufferedBytes: number;
  // Connections per user across all boards. Stops one account from exhausting the server.
  maxConnectionsPerUser: number;
  // A connection that has not answered a ping within this many milliseconds is abandoned.
  heartbeatTimeoutMs: number;
  heartbeatIntervalMs: number;
}

export const DEFAULT_CONNECTION_LIMITS: ConnectionLimits = {
  maxFrameBytes: 1024 * 1024,
  maxBufferedBytes: 8 * 1024 * 1024,
  maxConnectionsPerUser: 20,
  heartbeatTimeoutMs: 30_000,
  heartbeatIntervalMs: 15_000,
};

export const CLOSE_NORMAL = 1000;
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_PROTOCOL_ERROR = 1002;
export const CLOSE_MESSAGE_TOO_BIG = 1009;
export const CLOSE_POLICY_VIOLATION = 1008;
export const CLOSE_TRY_AGAIN_LATER = 1013;

// One WebSocket connection's state, from accept to close. The transport calls `receive` for each
// frame, `pong` when the client answers a ping, and `closed` when the socket goes away.
export class SyncConnection implements RoomConnection {
  readonly id: string;
  readonly userId: string;
  readonly boardId: string;
  readonly readOnly: boolean;
  private readonly socket: SocketLike;
  private readonly limits: ConnectionLimits;
  private readonly now: () => number;
  private lastPongAt: number;
  private closedFlag = false;
  private readonly onClosed: (connection: SyncConnection) => void;

  constructor(options: {
    id: string;
    userId: string;
    boardId: string;
    readOnly: boolean;
    socket: SocketLike;
    limits: ConnectionLimits;
    now: () => number;
    onClosed: (connection: SyncConnection) => void;
  }) {
    this.id = options.id;
    this.userId = options.userId;
    this.boardId = options.boardId;
    this.readOnly = options.readOnly;
    this.socket = options.socket;
    this.limits = options.limits;
    this.now = options.now;
    this.onClosed = options.onClosed;
    this.lastPongAt = options.now();
  }

  get isClosed(): boolean {
    return this.closedFlag;
  }

  // Returns false once the socket is closed or its outgoing buffer is past the limit. The room
  // then drops this connection, so a stalled reader cannot grow server memory without bound.
  send = (frame: Uint8Array): boolean => {
    if (this.closedFlag || this.socket.readyState !== 'open') {
      return false;
    }
    if (this.socket.bufferedAmount > this.limits.maxBufferedBytes) {
      this.close(CLOSE_TRY_AGAIN_LATER, 'client is not keeping up');
      return false;
    }
    this.socket.send(frame);
    return true;
  };

  pong(): void {
    this.lastPongAt = this.now();
  }

  // Sends a WebSocket ping. A client that answers with a pong refreshes lastPongAt.
  ping(): void {
    if (!this.closedFlag && this.socket.readyState === 'open') {
      this.socket.ping();
    }
  }

  // Returns true if the connection has been silent for too long. The caller then closes it.
  isStale(): boolean {
    return this.now() - this.lastPongAt > this.limits.heartbeatTimeoutMs;
  }

  // The outgoing frame check is done before the room sees the frame, so an oversized frame never
  // reaches the decoder.
  checkFrameSize(byteLength: number): boolean {
    if (byteLength > this.limits.maxFrameBytes) {
      this.close(CLOSE_MESSAGE_TOO_BIG, 'message is too large');
      return false;
    }
    return true;
  }

  // Closes the socket gracefully and reports the close once. Repeated calls are harmless.
  close(code: number, reason: string): void {
    if (this.closedFlag) {
      return;
    }
    this.closedFlag = true;
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
    this.onClosed(this);
  }

  // Called by the transport when the socket has gone, however it went.
  markClosed(): void {
    if (this.closedFlag) {
      return;
    }
    this.closedFlag = true;
    this.onClosed(this);
  }
}

// Tracks how many connections each user holds, across all boards.
export class UserConnectionCounter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly max: number) {}

  tryAcquire(userId: string): boolean {
    const current = this.counts.get(userId) ?? 0;
    if (current >= this.max) {
      return false;
    }
    this.counts.set(userId, current + 1);
    return true;
  }

  release(userId: string): void {
    const current = this.counts.get(userId) ?? 0;
    if (current <= 1) {
      this.counts.delete(userId);
    } else {
      this.counts.set(userId, current - 1);
    }
  }

  count(userId: string): number {
    return this.counts.get(userId) ?? 0;
  }
}
