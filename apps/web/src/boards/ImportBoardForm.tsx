import { useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router';
import { MAX_IMPORT_BYTES } from '@inkroom/shared';
import { describeError } from '../auth/messages';
import { importBoard } from './api';
import { readBoardFile } from './board-file';

const LIMIT_MB = MAX_IMPORT_BYTES / (1024 * 1024);

// Creates a board from a file made by InkRoom's export. The file is checked here and again on the
// server. When the import succeeds, the new board opens.
export function ImportBoardForm() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared so that choosing the same file again still counts as a change.
    event.target.value = '';
    if (!file) {
      return;
    }
    setError(null);
    if (file.size > MAX_IMPORT_BYTES) {
      setError(`This file is larger than ${LIMIT_MB} MB, the most InkRoom can import.`);
      return;
    }
    setImporting(true);
    try {
      const result = readBoardFile(await file.text());
      if ('error' in result) {
        setError(result.error);
        return;
      }
      const board = await importBoard(result.document);
      navigate(`/boards/${board.id}`);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setImporting(false);
    }
  }

  return (
    <section aria-label="Import board" className="import-form">
      <label htmlFor="import-board-file">Import a board file</label>
      <input
        id="import-board-file"
        type="file"
        accept="application/json,.json"
        disabled={importing}
        onChange={handleFile}
      />
      {importing && <p role="status">Importing…</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
