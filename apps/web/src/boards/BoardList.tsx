import { BoardRow } from './BoardRow';
import type { BoardListState } from './useBoardList';

export function BoardList({ list }: { list: BoardListState }) {
  if (list.status === 'loading') {
    return <p role="status">Loading boards…</p>;
  }

  if (list.status === 'error') {
    return (
      <div role="alert" className="panel">
        <p>Could not load your boards.</p>
        <p>{list.loadError}</p>
        <button type="button" onClick={() => void list.reload()}>
          Try again
        </button>
      </div>
    );
  }

  if (list.boards.length === 0) {
    return (
      <section aria-label="Boards" className="panel">
        <p>You do not have any boards yet.</p>
        <p>Create your first board above to get started.</p>
      </section>
    );
  }

  return (
    <section aria-label="Boards">
      <ul className="board-list">
        {list.boards.map((board) => (
          <BoardRow
            key={board.id}
            board={board}
            onRename={(title) => list.updateBoard(board.id, title)}
            onDelete={() => list.removeBoard(board.id)}
          />
        ))}
      </ul>
      {list.hasMore && (
        <button type="button" onClick={() => void list.loadMore()} disabled={list.loadingMore}>
          {list.loadingMore ? 'Loading more…' : 'Load more'}
        </button>
      )}
      {list.pageError && (
        <p role="alert" className="form-error">
          {list.pageError}
        </p>
      )}
    </section>
  );
}
