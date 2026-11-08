import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Board } from '@inkroom/shared';
import { describeError } from '../auth/messages';
import { fetchBoard } from '../boards/api';
import { roleLabels } from '../boards/format';
import { CanvasEditor } from '../canvas/CanvasEditor';

type BoardState =
  | { kind: 'loading' }
  | { kind: 'loaded'; board: Board }
  | { kind: 'error'; message: string };

export function BoardPage() {
  const { boardId = '' } = useParams();
  const [state, setState] = useState<BoardState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    fetchBoard(boardId)
      .then((board) => {
        if (active) {
          setState({ kind: 'loaded', board });
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
  }, [boardId]);

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
          <section aria-label="Whiteboard" className="workspace">
            <CanvasEditor boardId={state.board.id} />
          </section>
        </>
      )}
    </main>
  );
}
