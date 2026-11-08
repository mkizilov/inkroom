import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { boardTitleSchema, type Board } from '@inkroom/shared';
import { describeError } from '../auth/messages';
import { TextField } from '../components/TextField';
import { formatDateTime, roleLabels } from './format';

interface BoardRowProps {
  board: Board;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
}

type RowMode = 'view' | 'rename' | 'confirm-delete';

export function BoardRow({ board, onRename, onDelete }: BoardRowProps) {
  const [mode, setMode] = useState<RowMode>('view');
  const [draftTitle, setDraftTitle] = useState(board.title);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [rowError, setRowError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The server enforces these rules too; hiding the controls just avoids offering actions that
  // would be refused.
  const canRename = board.role === 'owner' || board.role === 'editor';
  const canDelete = board.role === 'owner';

  function startRename() {
    setDraftTitle(board.title);
    setFieldError(undefined);
    setRowError(null);
    setMode('rename');
  }

  function cancel() {
    setMode('view');
    setRowError(null);
  }

  async function handleRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = boardTitleSchema.safeParse(draftTitle);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message);
      return;
    }
    setFieldError(undefined);
    setBusy(true);
    try {
      await onRename(parsed.data);
      setMode('view');
    } catch (error) {
      setRowError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    setRowError(null);
    try {
      await onDelete();
    } catch (error) {
      setRowError(describeError(error));
      setBusy(false);
    }
  }

  return (
    <li className="board-row">
      {mode === 'rename' ? (
        <form onSubmit={handleRename} noValidate aria-label={`Rename ${board.title}`}>
          <TextField
            id={`rename-${board.id}`}
            label="Board name"
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            error={fieldError}
            disabled={busy}
          />
          <div className="row-actions">
            <button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={cancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="board-heading">
            <strong>{board.title}</strong>
            <span className="role-badge">{roleLabels[board.role]}</span>
          </div>
          <p className="board-dates">
            Created <time dateTime={board.createdAt}>{formatDateTime(board.createdAt)}</time>
            {' · '}
            Modified <time dateTime={board.updatedAt}>{formatDateTime(board.updatedAt)}</time>
          </p>
          <div className="row-actions">
            <Link to={`/boards/${board.id}`}>Open</Link>
            {canRename && (
              <button type="button" onClick={startRename} disabled={busy}>
                Rename
              </button>
            )}
            {canDelete && mode === 'view' && (
              <button type="button" onClick={() => setMode('confirm-delete')} disabled={busy}>
                Delete
              </button>
            )}
          </div>
          {mode === 'confirm-delete' && (
            <div className="confirm" role="group" aria-label={`Confirm delete ${board.title}`}>
              <p>Delete “{board.title}”? This cannot be undone.</p>
              <div className="row-actions">
                <button type="button" onClick={handleDelete} disabled={busy}>
                  {busy ? 'Deleting…' : 'Delete board'}
                </button>
                <button type="button" onClick={cancel} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {rowError && (
        <p role="alert" className="form-error">
          {rowError}
        </p>
      )}
    </li>
  );
}
