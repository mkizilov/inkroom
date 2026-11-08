import { z } from 'zod';
import { AppError } from '../http/errors';

export interface PageCursor {
  updatedAt: Date;
  id: string;
}

const cursorPayloadSchema = z.object({
  u: z.string().datetime(),
  i: z.string().uuid(),
});

// Cursors are opaque to clients. They are base64url-encoded JSON, so the format can change
// without breaking the API contract.
export function encodeCursor(position: PageCursor): string {
  const payload = { u: position.updatedAt.toISOString(), i: position.id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string): PageCursor {
  const invalid = () =>
    new AppError(400, 'validation_failed', 'The page cursor is invalid.', [
      { field: 'cursor', message: 'Use a cursor returned by a previous page.' },
    ]);

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }

  const parsed = cursorPayloadSchema.safeParse(json);
  if (!parsed.success) {
    throw invalid();
  }
  return { updatedAt: new Date(parsed.data.u), id: parsed.data.i };
}
