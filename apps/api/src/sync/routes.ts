import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthUser } from '@inkroom/shared';
import type { WebSocket } from 'ws';
import type { DbExecutor } from '../db/client';
import { requestSessionToken } from '../auth/middleware';
import { resolveSession } from '../auth/service';
import { CLOSE_POLICY_VIOLATION, type SocketLike, type SyncConnection } from './connections';
import type { SyncService } from './service';

export const SYNC_PATH = '/api/boards/:boardId/sync';

// The WebSocket readyState value for an open socket (RFC 6455 and the ws library).
const WS_OPEN = 1;

export interface SyncRouteOptions {
  db: DbExecutor;
  service: SyncService;
  webOrigin: string;
  cookieSecure: boolean;
}

// Adapts a `ws` socket to the SocketLike shape the sync service uses.
function adapt(socket: WebSocket): SocketLike {
  return {
    send: (data) => socket.send(data),
    ping: () => socket.ping(),
    close: (code, reason) => socket.close(code, reason),
    terminate: () => socket.terminate(),
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    get readyState() {
      return socket.readyState === WS_OPEN ? 'open' : 'closed';
    },
  };
}

// Authentication happens during the upgrade, before any board is opened. The browser sends its
// session cookie with the upgrade request, and the Origin check is the same rule the HTTP write
// routes use, which blocks cross-site WebSocket hijacking.
async function authenticate(
  request: FastifyRequest,
  options: SyncRouteOptions,
): Promise<AuthUser | null> {
  if (request.headers.origin !== options.webOrigin) {
    return null;
  }
  const token = requestSessionToken(request, options.cookieSecure);
  if (!token) {
    return null;
  }
  const session = await resolveSession(options.db, token);
  return session.status === 'active' ? session.user : null;
}

type RawMessage = { data: Buffer | ArrayBuffer | Buffer[]; isBinary: boolean };

export function registerSyncRoutes(app: FastifyInstance, options: SyncRouteOptions): void {
  app.get<{ Params: { boardId: string } }>(
    SYNC_PATH,
    { websocket: true },
    async (socket, request) => {
      // Listeners go on before the async checks, so no frame is lost while the board is being
      // authorized and loaded. Frames that arrive early are held until the connection is ready.
      let connection: SyncConnection | null = null;
      let closedEarly = false;
      const early: RawMessage[] = [];

      socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (connection) {
          deliver(connection, { data, isBinary }, options);
        } else {
          early.push({ data, isBinary });
        }
      });
      socket.on('pong', () => connection?.pong());
      socket.on('close', () => {
        closedEarly = connection === null;
        connection?.markClosed();
      });
      socket.on('error', () => connection?.markClosed());

      const user = await authenticate(request, options);
      if (!user) {
        socket.close(CLOSE_POLICY_VIOLATION, 'not signed in');
        return;
      }

      const result = await options.service.open({
        user,
        boardId: request.params.boardId,
        socket: adapt(socket),
      });
      if (!result.ok) {
        socket.close(result.code, result.reason);
        return;
      }

      connection = result.connection;
      if (closedEarly) {
        connection.markClosed();
        return;
      }
      for (const message of early.splice(0)) {
        deliver(connection, message, options);
      }
    },
  );
}

function deliver(connection: SyncConnection, message: RawMessage, options: SyncRouteOptions): void {
  if (!message.isBinary) {
    connection.close(CLOSE_POLICY_VIOLATION, 'binary frames only');
    return;
  }
  // The service settles this promise itself; a refused frame closes only its own connection.
  void options.service.receive(connection, toBytes(message.data));
}

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return new Uint8Array(data);
}
