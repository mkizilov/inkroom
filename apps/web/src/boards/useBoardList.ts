import { useCallback, useEffect, useState } from 'react';
import type { Board } from '@inkroom/shared';
import { describeError } from '../auth/messages';
import { createBoard, deleteBoard, fetchBoardPage, renameBoard } from './api';

export type ListStatus = 'loading' | 'ready' | 'error';

export interface BoardListState {
  boards: Board[];
  status: ListStatus;
  loadError: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  pageError: string | null;
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
  addBoard: (title: string) => Promise<void>;
  updateBoard: (boardId: string, title: string) => Promise<void>;
  removeBoard: (boardId: string) => Promise<void>;
}

// Owns the dashboard's board list. Mutations throw on failure so the row or form that started
// them can show the error next to the control the user operated.
export function useBoardList(): BoardListState {
  const [boards, setBoards] = useState<Board[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setStatus('loading');
    setLoadError(null);
    try {
      const page = await fetchBoardPage();
      setBoards(page.items);
      setNextCursor(page.nextCursor);
      setStatus('ready');
    } catch (error) {
      setLoadError(describeError(error));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) {
      return;
    }
    setLoadingMore(true);
    setPageError(null);
    try {
      const page = await fetchBoardPage(nextCursor);
      setBoards((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setPageError(describeError(error));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor]);

  const addBoard = useCallback(async (title: string) => {
    const board = await createBoard(title);
    setBoards((current) => [board, ...current]);
  }, []);

  const updateBoard = useCallback(async (boardId: string, title: string) => {
    const board = await renameBoard(boardId, title);
    setBoards((current) => current.map((item) => (item.id === boardId ? board : item)));
  }, []);

  const removeBoard = useCallback(async (boardId: string) => {
    await deleteBoard(boardId);
    setBoards((current) => current.filter((item) => item.id !== boardId));
  }, []);

  return {
    boards,
    status,
    loadError,
    hasMore: nextCursor !== null,
    loadingMore,
    pageError,
    reload,
    loadMore,
    addBoard,
    updateBoard,
    removeBoard,
  };
}
