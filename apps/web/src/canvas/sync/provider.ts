import { SyncClient, encodeAwareness } from '@inkroom/shared';
import type { CanvasDocument } from '../doc/canvas-document';
import { REMOTE_ORIGIN } from '../doc/canvas-document';

// Connects a board's CanvasDocument to its sync endpoint, and keeps the connection alive.
//
// Reconnection uses exponential backoff with jitter. A close with code 1008 (policy violation)
// means the server refused this user for this board, for example because the board was deleted or
// the membership was removed; the provider stops rather than retrying forever.
//
// Presence travels over the same socket. This client's state is sent on every connect, its later
// changes are forwarded as they happen, and remote participants are cleared on disconnect, since
// nothing can refresh them while the socket is down.

export const POLICY_VIOLATION_CLOSE = 1008;

// The WebSocket URL for a board's sync endpoint, on the page's own origin so the dev proxy and the
// session cookie both apply.
export function boardSyncUrl(
  boardId: string,
  location: { protocol: string; host: string },
): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/api/boards/${boardId}/sync`;
}

// The subset of WebSocket the provider uses, so tests can supply a fake.
export interface SocketLike {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface TimerLike {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'stopped';

export interface ProviderOptions {
  document: CanvasDocument;
  url: string;
  createSocket: SocketFactory;
  timers?: TimerLike;
  random?: () => number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  onState?: (state: ConnectionState) => void;
  // Told when the server changes this connection's role on the board.
  onRole?: (role: string) => void;
}

const DEFAULT_MIN_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 15_000;

const globalTimers: TimerLike = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class SyncProvider {
  private readonly document: CanvasDocument;
  private readonly client: SyncClient;
  private readonly options: ProviderOptions;
  private readonly timers: TimerLike;
  private readonly random: () => number;
  private socket: SocketLike | null = null;
  private retryHandle: unknown = null;
  private attempts = 0;
  private stopped = false;
  private state: ConnectionState = 'connecting';
  private unsubscribe: (() => void) | null = null;
  private unsubscribeAwareness: (() => void) | null = null;

  constructor(options: ProviderOptions) {
    this.options = options;
    this.document = options.document;
    this.timers = options.timers ?? globalTimers;
    this.random = options.random ?? Math.random;
    this.client = new SyncClient({
      doc: options.document.doc,
      remoteOrigin: REMOTE_ORIGIN,
      awareness: options.document.awareness,
      onRole: options.onRole,
    });
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  start(): void {
    if (this.stopped || this.socket) {
      return;
    }
    // Local changes are sent whenever the socket is open. A change made while offline is not
    // queued here; the sync handshake on reconnect carries it, because the state vector covers it.
    this.unsubscribe = this.document.onLocalUpdate((update) => {
      if (this.socket && this.isOpen(this.socket)) {
        this.socket.send(this.client.frameForLocalUpdate(update));
      }
    });
    this.unsubscribeAwareness = this.document.awareness.onLocalChange((body) => {
      if (this.socket && this.isOpen(this.socket)) {
        this.socket.send(encodeAwareness(body));
      }
    });
    this.connect();
  }

  // Closes the connection for good. No further reconnects are attempted.
  stop(): void {
    this.stopped = true;
    this.cancelRetry();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeAwareness?.();
    this.unsubscribeAwareness = null;
    this.document.awareness.removeRemoteStates();
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.onclose = null;
      socket.close(1000, 'closed by the client');
    }
    this.setState('stopped');
  }

  private connect(): void {
    this.cancelRetry();
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');
    // A new connection gets a new presence id. The server removes the old one when the old
    // connection closed, and a fresh id cannot be confused with its clock.
    this.document.awareness.rotateClientId();
    const socket = this.options.createSocket(this.options.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.setState('connected');
      socket.send(this.client.start());
      const local = this.document.awareness.getLocalState();
      if (local !== null) {
        socket.send(encodeAwareness(this.document.awareness.encodeLocal()));
      }
    };
    socket.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) {
        return;
      }
      for (const reply of this.client.receive(new Uint8Array(event.data))) {
        socket.send(reply);
      }
    };
    socket.onerror = () => {
      // The close event follows an error and decides what happens next.
    };
    socket.onclose = (event) => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.document.awareness.removeRemoteStates();
      if (this.stopped) {
        return;
      }
      if (event.code === POLICY_VIOLATION_CLOSE) {
        this.stop();
        return;
      }
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    const min = this.options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
    const max = this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const exponential = Math.min(max, min * 2 ** this.attempts);
    // Full jitter: a random delay up to the cap spreads reconnects from many clients apart.
    const delay = Math.round(this.random() * exponential);
    this.attempts += 1;
    this.setState('offline');
    this.retryHandle = this.timers.setTimeout(() => {
      this.retryHandle = null;
      this.connect();
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryHandle !== null) {
      this.timers.clearTimeout(this.retryHandle);
      this.retryHandle = null;
    }
  }

  private isOpen(socket: SocketLike): boolean {
    return socket.readyState === 1;
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.options.onState?.(state);
  }
}
