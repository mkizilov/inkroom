import {
  boardPageSchema,
  boardResponseSchema,
  type Board,
  type BoardExport,
  type BoardPage,
} from '@inkroom/shared';
import { apiRequest } from '../api/client';

export async function fetchBoardPage(cursor?: string): Promise<BoardPage> {
  const query = cursor ? `?${new URLSearchParams({ cursor }).toString()}` : '';
  return boardPageSchema.parse(await apiRequest(`/api/boards${query}`));
}

export async function fetchBoard(boardId: string): Promise<Board> {
  return boardResponseSchema.parse(await apiRequest(`/api/boards/${boardId}`)).board;
}

export async function createBoard(title: string): Promise<Board> {
  const payload = await apiRequest('/api/boards', { method: 'POST', body: { title } });
  return boardResponseSchema.parse(payload).board;
}

// Creates a board from an export. The server checks the file again before it creates anything.
export async function importBoard(document: BoardExport): Promise<Board> {
  const payload = await apiRequest('/api/boards/import', { method: 'POST', body: document });
  return boardResponseSchema.parse(payload).board;
}

export async function renameBoard(boardId: string, title: string): Promise<Board> {
  const payload = await apiRequest(`/api/boards/${boardId}`, { method: 'PATCH', body: { title } });
  return boardResponseSchema.parse(payload).board;
}

export async function deleteBoard(boardId: string): Promise<void> {
  await apiRequest(`/api/boards/${boardId}`, { method: 'DELETE' });
}
