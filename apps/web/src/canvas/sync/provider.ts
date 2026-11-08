import { SyncClient, carriesChanges, encodeAwareness } from '@inkroom/shared';
import type { CanvasDocument } from '../doc/canvas-document';
import { REMOTE_ORIGIN } from '../doc/canvas-document';

// Connects a board's CanvasDocument to its sync endpoint, and keeps the connection alive.
//
// Reconnection uses exponential backoff with jitter. A close with code 1008 (policy violation)
// means the server refused this user for this board, for example because the board was deleted or
// the membership was removed. The provider stops rather than retrying forever, and reports the
// server's reason so the page can act on it.
//
// State. "connected" means the server has answered this connection's handshake and has stored every
// change this client sent. "syncing" means the socket is open and one of those is still pending.
// Changes made offline are not queued here: the handshake sends them, because the state vector covers
// them, and they stay pending until the server stores them.
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
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface TimerLike {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type ConnectionState =
  'connecting' | 'connected' | 'syncing' | 'reconnecting' | 'offline' | 'stopped';

export interface ProviderOptions {
  document: CanvasDocument;
  url: string;
  createSocket: SocketFactory;
  timers?: TimerLike;
  random?: () => number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  // True when this user may view the board but not change it. Such a client sends no changes, so
  // none are counted as pending.
  readOnly?: boolean;
  onState?: (state: ConnectionState) => void;
  // Told when the server changes this connection's role on the board.
  onRole?: (role: string) => void;
  // Told when the server ends this user's access to the board, with the reason it gave.
  onRevoked?: (reason: string) => void;
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
  private readOnly: boolean;
  // The socket is open, and the server has not yet closed it.
  private open = false;
  // The server has answered this connection's state vector.
  private handshaken = false;
  // Frames that change the document and that the server has not stored yet.
  private unconfirmed = 0;

  constructor(options: ProviderOptions) {
    this.options = options;
    this.document = options.document;
    this.timers = options.timers ?? globalTimers;
    this.random = options.random ?? Math.random;
    this.readOnly = options.readOnly ?? false;
    this.client = new SyncClient({
      doc: options.document.doc,
      remoteOrigin: REMOTE_ORIGIN,
      awareness: options.document.awareness,
      onRole: (role) => this.applyRole(role),
      onAck: () => this.acknowledged(),
      onHandshake: () => this.handshakeAnswered(),
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
        this.send(this.socket, this.client.frameForLocalUpdate(update));
        this.refresh();
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
    this.open = false;
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
      this.open = true;
      this.handshaken = false;
      this.unconfirmed = 0;
      this.setState('syncing');
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
        this.send(socket, reply);
      }
      this.refresh();
    };
    socket.onerror = () => {
      // The close event follows an error and decides what happens next.
    };
    socket.onclose = (event) => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.open = false;
      this.unconfirmed = 0;
      this.document.awareness.removeRemoteStates();
      if (this.stopped) {
        return;
      }
      if (event.code === POLICY_VIOLATION_CLOSE) {
        this.stop();
        this.options.onRevoked?.(event.reason ?? '');
        return;
      }
      this.scheduleRetry();
    };
  }

  // Sends a frame. A frame that changes the document counts as pending until the server stores it.
  // A read-only client sends no changes, so nothing is counted for it.
  private send(socket: SocketLike, frame: Uint8Array): void {
    if (!this.readOnly && carriesChanges(frame)) {
      this.unconfirmed += 1;
    }
    socket.send(frame);
  }

  private applyRole(role: string): void {
    this.readOnly = role === 'viewer';
    if (this.readOnly) {
      // A viewer's changes are never stored, so none of the pending ones will be acknowledged.
      this.unconfirmed = 0;
    }
    this.refresh();
    this.options.onRole?.(role);
  }

  private acknowledged(): void {
    this.unconfirmed = Math.max(0, this.unconfirmed - 1);
    this.refresh();
  }

  private handshakeAnswered(): void {
    this.handshaken = true;
    this.refresh();
  }

  // Derives "connected" or "syncing" from what the server has confirmed. Offline states come from
  // the socket's own events, so nothing is derived while the socket is not open.
  private refresh(): void {
    if (!this.open) {
      return;
    }
    const next: ConnectionState =
      this.handshaken && this.unconfirmed === 0 ? 'connected' : 'syncing';
    if (next !== this.state) {
      this.setState(next);
    }
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
