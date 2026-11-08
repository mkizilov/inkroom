import {
  memberListSchema,
  memberResponseSchema,
  type GrantableRole,
  type Member,
} from '@inkroom/shared';
import { apiRequest } from '../api/client';

export async function fetchMembers(boardId: string): Promise<Member[]> {
  return memberListSchema.parse(await apiRequest(`/api/boards/${boardId}/members`)).items;
}

export async function inviteMember(
  boardId: string,
  email: string,
  role: GrantableRole,
): Promise<Member> {
  const payload = await apiRequest(`/api/boards/${boardId}/members`, {
    method: 'POST',
    body: { email, role },
  });
  return memberResponseSchema.parse(payload).member;
}

export async function changeMemberRole(
  boardId: string,
  userId: string,
  role: GrantableRole,
): Promise<Member> {
  const payload = await apiRequest(`/api/boards/${boardId}/members/${userId}`, {
    method: 'PATCH',
    body: { role },
  });
  return memberResponseSchema.parse(payload).member;
}

// Removes a member. The owner uses it on others; any member uses it on themselves to leave.
export async function removeMember(boardId: string, userId: string): Promise<void> {
  await apiRequest(`/api/boards/${boardId}/members/${userId}`, { method: 'DELETE' });
}
