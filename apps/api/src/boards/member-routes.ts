import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  boardIdParamsSchema,
  changeMemberRoleSchema,
  inviteMemberSchema,
  memberParamsSchema,
} from '@inkroom/shared';
import type { DbExecutor } from '../db/client';
import { currentUserOf } from '../auth/middleware';
import { parseBody, parseParams } from '../http/validation';
import type { SyncService } from '../sync/service';
import { authorizeBoard } from './access';
import { changeMemberRole, inviteMember, listMembers, removeMember } from './members';

export interface MemberRouteOptions {
  db: DbExecutor;
  sync: SyncService;
  requireUser: (request: FastifyRequest) => Promise<void>;
}

// Sharing. Any member can see who has access; only the owner can change it. A member may also leave
// on their own. Every change reaches the connections open on the board at once: a role change is
// applied and announced, and a removal closes the affected connections.
export function registerMemberRoutes(app: FastifyInstance, options: MemberRouteOptions): void {
  const { db, sync, requireUser } = options;

  app.get<{ Params: { boardId: string } }>(
    '/api/boards/:boardId/members',
    { preHandler: requireUser },
    async (request) => {
      const user = currentUserOf(request);
      const { boardId } = parseParams(boardIdParamsSchema, request.params);
      const role = await authorizeBoard(db, boardId, user.id, 'read');
      return { items: await listMembers(db, boardId, role) };
    },
  );

  app.post<{ Params: { boardId: string } }>(
    '/api/boards/:boardId/members',
    { preHandler: requireUser },
    async (request, reply) => {
      const user = currentUserOf(request);
      const { boardId } = parseParams(boardIdParamsSchema, request.params);
      const body = parseBody(inviteMemberSchema, request.body);
      await authorizeBoard(db, boardId, user.id, 'manage_members');
      const member = await inviteMember(db, boardId, body.email, body.role);
      return reply.code(201).send({ member });
    },
  );

  app.patch<{ Params: { boardId: string; userId: string } }>(
    '/api/boards/:boardId/members/:userId',
    { preHandler: requireUser },
    async (request) => {
      const user = currentUserOf(request);
      const { boardId, userId } = parseParams(memberParamsSchema, request.params);
      const body = parseBody(changeMemberRoleSchema, request.body);
      await authorizeBoard(db, boardId, user.id, 'manage_members');
      const member = await changeMemberRole(db, boardId, userId, body.role);
      sync.applyMembership(boardId, userId, body.role);
      return { member };
    },
  );

  app.delete<{ Params: { boardId: string; userId: string } }>(
    '/api/boards/:boardId/members/:userId',
    { preHandler: requireUser },
    async (request, reply) => {
      const user = currentUserOf(request);
      const { boardId, userId } = parseParams(memberParamsSchema, request.params);
      if (userId === user.id) {
        // Leaving: any member may do it. The owner is refused inside removeMember.
        await authorizeBoard(db, boardId, user.id, 'read');
      } else {
        await authorizeBoard(db, boardId, user.id, 'manage_members');
      }
      await removeMember(db, boardId, userId);
      sync.applyMembership(boardId, userId, null);
      return reply.code(204).send();
    },
  );
}
