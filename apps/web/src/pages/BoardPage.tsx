import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Board } from '@inkroom/shared';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { describeError } from '../auth/messages';
import { fetchBoard } from '../boards/api';
import { roleLabels } from '../boards/format';
import { CanvasEditor } from '../canvas/CanvasEditor';
import { browserLocalStore } from '../offline/indexeddb-store';
import type { LocalStore } from '../offline/local-store';
import { SharingPanel } from '../sharing/SharingPanel';

type BoardState =
  | { kind: 'loading' }
  | { kind: 'loaded'; board: Board; fromDevice: boolean }
  | { kind: 'error'; message: string };

// Opens a board from the server, and keeps its details on this device. When the server cannot be
// reached, the details saved here are used instead. When the server says the board is not there for
// this user, the copy on this device is deleted.
async function openBoard(
  boardId: string,
  store: LocalStore | null,
  userId: string | undefined,
): Promise<{ board: Board; fromDevice: boolean }> {
  try {
    const board = await fetchBoard(boardId);
    if (store && userId) {
      await store.saveBoard(userId, board).catch((error: unknown) => {
        console.warn('The board could not be kept on this device.', error);
      });
    }
    return { board, fromDevice: false };
  } catch (error) {
    if (store && userId && error instanceof ApiError) {
      if (error.status === 0) {
        const saved = await store.loadBoard(userId, boardId);
        if (saved) {
          return { board: saved.board, fromDevice: true };
        }
      }
      if (error.status === 404) {
        await store.removeBoard(userId, boardId);
      }
    }
    throw error;
  }
}

export function BoardPage() {
  const { boardId = '' } = useParams();
  const { state: auth } = useAuth();
  const [state, setState] = useState<BoardState>({ kind: 'loading' });
  const store = browserLocalStore();
  const userId = auth.status === 'authenticated' ? auth.user.id : undefined;

  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    openBoard(boardId, store, userId)
      .then(({ board, fromDevice }) => {
        if (active) {
          setState({ kind: 'loaded', board, fromDevice });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setState({ kind: 'error', message: describeError(error) });
        }
      });
    return () => {
      active = false;
    };
  }, [boardId, store, userId]);

  return (
    <main>
      <p>
        <Link to="/">Back to boards</Link>
      </p>
      {state.kind === 'loading' && <p role="status">Loading board…</p>}
      {state.kind === 'error' && (
        <div role="alert" className="panel">
          <p>Could not open this board.</p>
          <p>{state.message}</p>
        </div>
      )}
      {state.kind === 'loaded' && (
        <>
          <header className="page-header">
            <div>
              <h1>{state.board.title}</h1>
              <p>Your role: {roleLabels[state.board.role]}</p>
            </div>
          </header>
          {state.fromDevice ? (
            <p role="status">Opened from the copy saved on this device.</p>
          ) : (
            <SharingPanel boardId={state.board.id} role={state.board.role} currentUserId={userId} />
          )}
          <section aria-label="Whiteboard" className="workspace">
            <CanvasEditor
              boardId={state.board.id}
              role={state.board.role}
              offline={store && userId ? { store, userId } : undefined}
              user={
                auth.status === 'authenticated'
                  ? { id: auth.user.id, name: auth.user.displayName }
                  : undefined
              }
            />
          </section>
        </>
      )}
    </main>
  );
}
