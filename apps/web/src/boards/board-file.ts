import { BOARD_EXPORT_VERSION, boardExportSchema, type BoardExport } from '@inkroom/shared';

export type BoardFileResult = { document: BoardExport } | { error: string };

// Checks the text of a file before anything is sent. A refused file gets a message that says why.
// The server checks the same schema again, so this only gives the user an answer sooner.
export function readBoardFile(text: string): BoardFileResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: 'This file is not valid JSON.' };
  }

  const version =
    typeof value === 'object' && value !== null && 'version' in value ? value.version : undefined;
  if (version !== undefined && version !== BOARD_EXPORT_VERSION) {
    return {
      error: `This file uses version ${String(version)} of the board format. This version of InkRoom reads version ${BOARD_EXPORT_VERSION}.`,
    };
  }

  const parsed = boardExportSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? ` (${issue.path.join('.') || 'file'}: ${issue.message})` : '';
    return { error: `This is not a valid InkRoom board export${where}.` };
  }
  return { document: parsed.data };
}
